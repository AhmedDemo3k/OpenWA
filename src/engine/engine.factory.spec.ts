import { ConfigService } from '@nestjs/config';
import { EngineFactory } from './engine.factory';
import { PluginLoaderService, PluginType, IEnginePlugin } from '../core/plugins';
import { WhatsAppWebJsPlugin } from '../plugins/engines/whatsapp-web-js';

/**
 * Regression cover for the engine plugin's configuration plumbing.
 *
 * The plugin reads its settings from `PluginContext.config`, which is the plugin's *stored*
 * config in the plugin storage table -- never from ConfigService. Nothing ever seeded
 * `sessionDataPath` into that stored config, so the plugin fell through to its hardcoded
 * './data/sessions' default while `engine.sessionDataPath` sat unread in the fallback path.
 *
 * The visible symptom was sessions being written into the live ./data/sessions directory even
 * when SESSION_DATA_PATH pointed somewhere else entirely, because the operator's setting was
 * silently discarded. EngineFactory.create() now passes the ConfigService-resolved values into
 * every createEngine() call, and these tests hold that line.
 */
describe('EngineFactory engine config', () => {
  const sessionDataPath = '/tmp/some-other-place/sessions';

  let factory: EngineFactory;
  let createEngine: jest.Mock;

  const build = (): EngineFactory => {
    const plugin: IEnginePlugin = {
      type: PluginType.ENGINE,
      onLoad: jest.fn(),
      onEnable: jest.fn(),
      onDisable: jest.fn(),
      onUnload: jest.fn(),
      createEngine,
      getFeatures: () => [],
      healthCheck: () => Promise.resolve({ healthy: true }),
    };

    const pluginLoader = {
      getPlugin: () => ({ instance: plugin }),
      isPluginEnabled: () => true,
      enablePlugin: jest.fn().mockResolvedValue(undefined),
      registerBuiltInPlugin: jest.fn(),
      updatePluginConfig: jest.fn(),
      getPluginsByType: () => [],
    } as unknown as PluginLoaderService;

    const configService = {
      get: jest.fn((key: string) => {
        const values: Record<string, unknown> = {
          'engine.type': 'whatsapp-web.js',
          'engine.sessionDataPath': sessionDataPath,
          'engine.puppeteer.headless': false,
          'engine.puppeteer.args': ['--no-sandbox', '--single-process'],
        };
        return values[key];
      }),
    } as unknown as ConfigService;

    return new EngineFactory(configService, pluginLoader);
  };

  beforeEach(() => {
    createEngine = jest.fn().mockReturnValue({ fake: 'engine' });
    factory = build({});
  });

  it('passes the configured session data path into the plugin', () => {
    factory.create({ sessionId: 'abc' });

    expect(createEngine).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'abc', sessionDataPath }));
  });

  it('passes puppeteer headless and args through rather than the plugin defaults', () => {
    factory.create({ sessionId: 'abc' });

    expect(createEngine).toHaveBeenCalledWith(
      expect.objectContaining({
        headless: false,
        puppeteerArgs: ['--no-sandbox', '--single-process'],
      }),
    );
  });

  it('keeps the executable path in stored plugin config but resolves the rest per call', async () => {
    // sessionDataPath must not go through updatePluginConfig: stored plugin config survives
    // across boots, so a value written there would go stale the moment SESSION_DATA_PATH changed.
    const updatePluginConfig = jest.fn();
    const plugin = {
      type: PluginType.ENGINE,
      onLoad: jest.fn(),
      onEnable: jest.fn(),
      onDisable: jest.fn(),
      onUnload: jest.fn(),
      createEngine,
      getFeatures: () => [],
      healthCheck: () => Promise.resolve({ healthy: true }),
    };
    const pluginLoader = {
      getPlugin: () => ({ instance: plugin }),
      isPluginEnabled: () => true,
      enablePlugin: jest.fn().mockResolvedValue(undefined),
      registerBuiltInPlugin: jest.fn(),
      updatePluginConfig,
      getPluginsByType: () => [],
    } as unknown as PluginLoaderService;
    const configService = {
      get: jest.fn((key: string) => (key === 'PUPPETEER_EXECUTABLE_PATH' ? 'C:/chrome.exe' : undefined)),
    } as unknown as ConfigService;

    await new EngineFactory(configService, pluginLoader).onModuleInit();

    expect(updatePluginConfig).toHaveBeenCalledWith('whatsapp-web.js', {
      puppeteerExecutablePath: 'C:/chrome.exe',
    });
    const storedKeys = updatePluginConfig.mock.calls.flatMap((call: unknown[]) => {
      const config = call[1] as Record<string, unknown>;
      return Object.keys(config);
    });
    expect(storedKeys).not.toContain('sessionDataPath');
    expect(storedKeys).not.toContain('headless');
    expect(storedKeys).not.toContain('puppeteerArgs');
  });
});

describe('WhatsAppWebJsPlugin.createEngine', () => {
  const baseConfig = { sessionId: 'abc', proxyUrl: undefined, proxyType: undefined };

  const pluginWithStoredConfig = async (config: Record<string, unknown>): Promise<WhatsAppWebJsPlugin> => {
    const plugin = new WhatsAppWebJsPlugin();
    await plugin.onLoad({
      pluginId: 'whatsapp-web.js',
      manifest: { id: 'whatsapp-web.js' },
      config,
      logger: {
        log: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
      storage: {} as never,
      hookManager: {} as never,
      registerHook: jest.fn(),
      getService: jest.fn(),
    } as never);
    return plugin;
  };

  const dataPathOf = (engine: unknown): string =>
    (engine as { config: { sessionDataPath: string } }).config.sessionDataPath;

  it('prefers the per-call session data path over stored plugin config', async () => {
    // The stale value stands in for a real one left over from an earlier boot.
    const plugin = await pluginWithStoredConfig({ sessionDataPath: '/stale/path' });

    const engine = plugin.createEngine({ ...baseConfig, sessionDataPath: '/correct/path' });

    expect(dataPathOf(engine)).toBe('/correct/path');
  });

  it('falls back to stored plugin config when no per-call value is given', async () => {
    const plugin = await pluginWithStoredConfig({ sessionDataPath: '/stored/path' });

    expect(dataPathOf(plugin.createEngine(baseConfig))).toBe('/stored/path');
  });

  it('falls back to the built-in default when neither source has a value', async () => {
    const plugin = await pluginWithStoredConfig({});

    expect(dataPathOf(plugin.createEngine(baseConfig))).toBe('./data/sessions');
  });

  it('reads puppeteer headless from the per-call config', async () => {
    const plugin = await pluginWithStoredConfig({ headless: true });

    const engine = plugin.createEngine({ ...baseConfig, headless: false });

    expect((engine as { config: { puppeteer: { headless: boolean } } }).config.puppeteer.headless).toBe(false);
  });
});
