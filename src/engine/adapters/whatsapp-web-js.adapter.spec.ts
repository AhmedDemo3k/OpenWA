import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';

jest.mock('child_process', () => {
  const actual = jest.requireActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: jest.fn(() => {
      const emitter = new EventEmitter();
      setImmediate(() => emitter.emit('close', 0));
      return emitter;
    }),
  };
});

const spawnMock = spawn as jest.MockedFunction<typeof spawn>;

type TeardownableAdapter = {
  client: unknown;
  teardownClient(): Promise<void>;
};

function createAdapter(): WhatsAppWebJsAdapter {
  return new WhatsAppWebJsAdapter({ sessionId: 'test-session', sessionDataPath: './data/sessions' });
}

/**
 * whatsapp-web.js Client.destroy() only calls browser.close() when browser.isConnected() is
 * truthy, so a browser mid-launch or already flagged disconnected leaks its Chromium tree.
 * These tests pin the adapter-level guarantee that teardown always ends with a dead process.
 */
describe('WhatsAppWebJsAdapter teardown', () => {
  beforeEach(() => {
    spawnMock.mockClear();
  });

  it('closes the browser directly and does not spawn a killer when the process exits', async () => {
    const proc = { pid: 4321, exitCode: null as number | null, killed: false };
    const browser = {
      close: jest.fn().mockImplementation(() => {
        proc.exitCode = 0;
        return Promise.resolve();
      }),
      process: jest.fn().mockReturnValue(proc),
    };
    const client = {
      removeAllListeners: jest.fn(),
      destroy: jest.fn().mockResolvedValue(undefined),
      pupBrowser: browser,
    };

    const adapter = createAdapter();
    (adapter as unknown as TeardownableAdapter).client = client;

    await (adapter as unknown as TeardownableAdapter).teardownClient();

    expect(client.destroy).toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('force-kills the process tree when the browser is still alive after close', async () => {
    const proc = { pid: 7654, exitCode: null as number | null, killed: false };
    const browser = {
      close: jest.fn().mockResolvedValue(undefined),
      process: jest.fn().mockReturnValue(proc),
    };
    const client = {
      removeAllListeners: jest.fn(),
      destroy: jest.fn().mockResolvedValue(undefined),
      pupBrowser: browser,
    };

    const adapter = createAdapter();
    (adapter as unknown as TeardownableAdapter).client = client;

    await (adapter as unknown as TeardownableAdapter).teardownClient();

    if (process.platform === 'win32') {
      expect(spawnMock).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '7654', '/T', '/F'],
        expect.objectContaining({ stdio: 'ignore' }),
      );
    } else {
      expect(proc.killed).toBe(true);
    }
  }, 10000);

  it('still reaches the process kill when client.destroy() rejects', async () => {
    const proc = { pid: 9999, exitCode: null as number | null, killed: false };
    const browser = {
      close: jest.fn().mockRejectedValue(new Error('target closed')),
      process: jest.fn().mockReturnValue(proc),
    };
    const client = {
      removeAllListeners: jest.fn(),
      destroy: jest.fn().mockRejectedValue(new Error('boom')),
      pupBrowser: browser,
    };

    const adapter = createAdapter();
    (adapter as unknown as TeardownableAdapter).client = client;

    await expect((adapter as unknown as TeardownableAdapter).teardownClient()).resolves.toBeUndefined();

    if (process.platform === 'win32') {
      expect(spawnMock).toHaveBeenCalled();
    } else {
      expect(proc.killed).toBe(true);
    }
  }, 10000);
});
