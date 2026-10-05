/**
 * Manual mock for `puppeteer` / `puppeteer-core`.
 *
 * Puppeteer 25 is an ESM-only package. Jest runs this project as CommonJS, so importing it
 * transitively (engine.factory -> whatsapp-web-js adapter -> puppeteer) throws
 * "Must use import to load ES Module" and takes down every suite that touches the engine.
 *
 * These are unit tests of Nest services (SessionService, MessageService, ...) that already
 * inject a mocked EngineFactory, so a real browser driver is never used. Stubbing it here
 * keeps the suites fast (no ~300 MB browser library load) and independent of the ESM/CJS
 * split. Anything that genuinely needs a browser is an integration concern and should drive
 * the real puppeteer in a separate harness, not in `npm test`.
 */
const noop = () => undefined;

const fakePage = {
  evaluate: jest.fn().mockResolvedValue(undefined),
  exposeFunction: jest.fn().mockResolvedValue(undefined),
  removeExposedFunction: jest.fn().mockResolvedValue(undefined),
  waitForSelector: jest.fn().mockResolvedValue(null),
  waitForNavigation: jest.fn().mockResolvedValue(null),
  goto: jest.fn().mockResolvedValue(undefined),
  setContent: jest.fn().mockResolvedValue(undefined),
  setViewport: jest.fn().mockResolvedValue(undefined),
  setDefaultTimeout: noop,
  setDefaultNavigationTimeout: noop,
  setUserAgent: jest.fn().mockResolvedValue(undefined),
  screenshot: jest.fn().mockResolvedValue(Buffer.from('')),
  url: jest.fn().mockReturnValue('about:blank'),
  content: jest.fn().mockResolvedValue('<html></html>'),
  title: jest.fn().mockResolvedValue(''),
  reload: jest.fn().mockResolvedValue(undefined),
  bringToFront: noop,
  close: jest.fn().mockResolvedValue(undefined),
  on: jest.fn(),
  once: jest.fn(),
  off: jest.fn(),
  removeAllListeners: jest.fn(),
  target: jest.fn().mockReturnValue({ createCDPSession: jest.fn() }),
  keyboard: { press: jest.fn(), type: jest.fn(), down: jest.fn(), up: jest.fn() },
  mouse: { click: jest.fn(), move: jest.fn() },
};

const fakeBrowser = {
  newPage: jest.fn().mockResolvedValue(fakePage),
  pages: jest.fn().mockResolvedValue([fakePage]),
  close: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn(),
  version: jest.fn().mockReturnValue('Chrome/stub'),
  wsEndpoint: jest.fn().mockReturnValue('ws://localhost/stub'),
  process: { kill: noop },
  on: jest.fn(),
  once: jest.fn(),
  off: jest.fn(),
  removeAllListeners: jest.fn(),
  isConnected: jest.fn().mockReturnValue(true),
};

module.exports = {
  __esModule: true,
  default: {
    launch: jest.fn().mockResolvedValue(fakeBrowser),
    connect: jest.fn().mockResolvedValue(fakeBrowser),
    executablePath: jest.fn().mockReturnValue(''),
    devices: {},
    __fakePage: fakePage,
    __fakeBrowser: fakeBrowser,
  },
  launch: jest.fn().mockResolvedValue(fakeBrowser),
  connect: jest.fn().mockResolvedValue(fakeBrowser),
  executablePath: jest.fn().mockReturnValue(''),
  devices: {},
  __fakePage: fakePage,
  __fakeBrowser: fakeBrowser,
};
