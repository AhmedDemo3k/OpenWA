import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Response } from 'express';
import { HealthController } from './health.controller';
import { CacheService } from '../../common/cache/cache.service';

type Behaviour = 'ok' | 'fail' | 'uninitialised' | 'hang';

/** Minimal stand-in for the express response object the controller writes to. */
interface MockRes {
  res: Response;
  /** Last status code explicitly set, or 0 if the controller never called `status()`. */
  statusCode: number;
  setStatus: jest.Mock;
}

function createMockRes(): MockRes {
  const holder: MockRes = {
    res: undefined as unknown as Response,
    statusCode: 0,
    setStatus: jest.fn(),
  };
  holder.setStatus = jest.fn((code: number) => {
    holder.statusCode = code;
    return holder.res;
  });
  holder.res = { status: holder.setStatus } as unknown as Response;
  return holder;
}

function makeDataSource(behaviour: Behaviour): Partial<DataSource> {
  return {
    isInitialized: behaviour !== 'uninitialised',
    query: jest.fn().mockImplementation(() => {
      if (behaviour === 'hang') return new Promise<never>(() => undefined);
      if (behaviour === 'fail') return Promise.reject(new Error('connection refused'));
      return Promise.resolve([{ 1: 1 }]);
    }),
  };
}

describe('HealthController', () => {
  let main: Partial<DataSource>;
  let data: Partial<DataSource>;
  let cache: { isAvailable: jest.Mock };

  async function build(
    mainBehaviour: Behaviour,
    dataBehaviour: Behaviour,
    cacheAvailable = true,
  ): Promise<HealthController> {
    main = makeDataSource(mainBehaviour);
    data = makeDataSource(dataBehaviour);
    cache = { isAvailable: jest.fn().mockResolvedValue(cacheAvailable) };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: getDataSourceToken('main'), useValue: main },
        { provide: getDataSourceToken('data'), useValue: data },
        { provide: CacheService, useValue: cache },
      ],
    }).compile();

    return module.get<HealthController>(HealthController);
  }

  describe('check (liveness)', () => {
    it('reports ok with a timestamp and uptime', async () => {
      const controller = await build('ok', 'ok');
      const result = controller.check();

      expect(result.status).toBe('ok');
      expect(result.timestamp).toBeDefined();
      expect(typeof result.uptimeSeconds).toBe('number');
    });

    it('stays ok even when every dependency is down (must not trigger a restart loop)', async () => {
      const controller = await build('fail', 'fail', false);

      expect(controller.check().status).toBe('ok');
      expect(controller.liveness().status).toBe('ok');
    });
  });

  describe('readiness', () => {
    it('returns 200 and probes both databases when healthy', async () => {
      const controller = await build('ok', 'ok');
      const mock = createMockRes();

      const result = await controller.readiness(mock.res);

      expect(result.status).toBe('ok');
      expect(result.details?.database_main).toMatchObject({ status: 'up' });
      expect(result.details?.database_data).toMatchObject({ status: 'up' });
      expect(main.query).toHaveBeenCalledWith('SELECT 1');
      expect(data.query).toHaveBeenCalledWith('SELECT 1');
      // Never touching status() means Nest keeps its default 200.
      expect(mock.setStatus).not.toHaveBeenCalled();
    });

    it('returns a real 503 when the main database is unreachable', async () => {
      const controller = await build('fail', 'ok');
      const mock = createMockRes();

      const result = await controller.readiness(mock.res);

      expect(result.status).toBe('error');
      expect(result.details?.database_main).toMatchObject({ status: 'down' });
      // The status code is what the Docker healthcheck and watchdog actually read.
      expect(mock.setStatus).toHaveBeenCalledWith(503);
    });

    it('returns a real 503 when the data database is unreachable', async () => {
      const controller = await build('ok', 'fail');
      const mock = createMockRes();

      const result = await controller.readiness(mock.res);

      expect(result.status).toBe('error');
      expect(result.details?.database_data).toMatchObject({ status: 'down' });
      expect(mock.setStatus).toHaveBeenCalledWith(503);
    });

    it('returns 503 when a DataSource was never initialised', async () => {
      const controller = await build('uninitialised', 'ok');
      const mock = createMockRes();

      const result = await controller.readiness(mock.res);

      expect(result.status).toBe('error');
      expect(result.details?.database_main).toMatchObject({ status: 'down' });
      expect(mock.setStatus).toHaveBeenCalledWith(503);
    });

    it('times out instead of hanging forever on a wedged connection', async () => {
      const controller = await build('hang', 'ok');
      const mock = createMockRes();

      const result = await controller.readiness(mock.res);

      expect(result.status).toBe('error');
      expect(result.details?.database_main).toMatchObject({ status: 'down' });
      expect((result.details?.database_main as { error?: string }).error).toContain('timed out');
      expect(mock.setStatus).toHaveBeenCalledWith(503);
    }, 10_000);

    it('treats Redis as optional: stays ready but flagged degraded', async () => {
      const controller = await build('ok', 'ok', false);
      const mock = createMockRes();

      const result = await controller.readiness(mock.res);

      expect(result.status).toBe('ok');
      expect(result.details?.redis).toMatchObject({ status: 'down' });
      expect(result.details?.degraded).toBe(true);
      expect(mock.setStatus).not.toHaveBeenCalled();
    });

    it('is not degraded when Redis is up', async () => {
      const controller = await build('ok', 'ok', true);
      const mock = createMockRes();

      const result = await controller.readiness(mock.res);

      expect(result.details?.degraded).toBe(false);
    });
  });
});
