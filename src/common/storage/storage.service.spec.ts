import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import * as tar from 'tar-stream';
import * as zlib from 'zlib';

/** Unpacks a .tar.gz buffer into a name -> contents map. */
function extractEntries(gz: Buffer): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const extract = tar.extract();
    const contents: Record<string, string> = {};
    extract.on('entry', (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        contents[header.name] = Buffer.concat(chunks).toString('utf8');
        next();
      });
      stream.resume();
    });
    extract.on('finish', () => resolve(contents));
    extract.on('error', reject);
    Readable.from([gz]).pipe(zlib.createGunzip()).pipe(extract);
  });
}

function makeGzippedTar(entries: { name: string; body: string }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tar.pack();
    const chunks: Buffer[] = [];
    pack.on('data', (c: Buffer) => chunks.push(c));
    pack.on('end', () => resolve(zlib.gzipSync(Buffer.concat(chunks))));
    pack.on('error', reject);
    for (const e of entries) pack.entry({ name: e.name }, e.body);
    pack.finalize();
  });
}

describe('StorageService', () => {
  let service: StorageService;
  let root: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-storage-'));

    const config = { get: jest.fn((key: string) => (key === 'storage.localPath' ? root : undefined)) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [StorageService, { provide: ConfigService, useValue: config }],
    }).compile();

    service = module.get<StorageService>(StorageService);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('path traversal', () => {
    it('writes a normal relative path inside the storage root', async () => {
      await service.putFile('media/photo.png', Buffer.from('png'));

      expect(fs.readFileSync(path.join(root, 'media', 'photo.png'), 'utf8')).toBe('png');
    });

    it('refuses to write outside the storage root via ../', async () => {
      const escape = path.join('..', 'escaped.txt');

      await expect(service.putFile(escape, Buffer.from('pwned'))).rejects.toThrow(/escapes the storage root/);

      expect(fs.existsSync(path.join(path.dirname(root), 'escaped.txt'))).toBe(false);
    });

    it('refuses an absolute path that points outside the storage root', async () => {
      const target = path.join(root, '..', '..', 'absolute-escape.txt');

      await expect(service.putFile(target, Buffer.from('pwned'))).rejects.toThrow(/escapes the storage root/);
    });

    it('refuses to read outside the storage root', async () => {
      const outside = path.join(path.dirname(root), 'secret.txt');
      fs.writeFileSync(outside, 'top secret');

      await expect(service.getFile(path.join('..', 'secret.txt'))).rejects.toThrow(/escapes the storage root/);
    });

    it('refuses a traversal that re-enters the root (prefix-collision guard)', async () => {
      // `<root>-evil` shares a string prefix with `<root>`; a naive startsWith check
      // without the separator would let this through.
      const sibling = `${root}-evil`;
      fs.mkdirSync(sibling, { recursive: true });

      await expect(
        service.putFile(path.join('..', `${path.basename(sibling)}`, 'x.txt'), Buffer.from('pwned')),
      ).rejects.toThrow(/escapes the storage root/);
    });
  });

  describe('importFromStream', () => {
    it('imports a valid .tar.gz and reports the count', async () => {
      const gz = await makeGzippedTar([
        { name: 'a.txt', body: 'alpha' },
        { name: 'nested/b.txt', body: 'beta' },
      ]);

      const count = await service.importFromStream(Readable.from(gz));

      expect(count).toBe(2);
      expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('alpha');
      expect(fs.readFileSync(path.join(root, 'nested', 'b.txt'), 'utf8')).toBe('beta');
    });

    it('rejects a corrupt archive instead of crashing on an unhandled gunzip error', async () => {
      // Not gzip at all: the gunzip stage emits 'error'. With the old `.pipe()` chain
      // nothing listened for it, so it surfaced as an uncaught exception and took the
      // whole process down.
      const garbage = Buffer.from('this is definitely not a gzip stream');

      await expect(service.importFromStream(Readable.from(garbage))).rejects.toBeDefined();
    });

    it('rejects when the client aborts mid-upload rather than hanging forever', async () => {
      const stream = new Readable({ read() {} });
      const promise = service.importFromStream(stream);

      stream.destroy(new Error('client hung up'));

      await expect(promise).rejects.toThrow('client hung up');
    });

    it('skips a traversing entry but still imports the safe ones', async () => {
      const gz = await makeGzippedTar([
        { name: '../../pwned.txt', body: 'evil' },
        { name: 'good.txt', body: 'safe' },
      ]);

      const count = await service.importFromStream(Readable.from(gz));

      expect(count).toBe(1);
      expect(fs.existsSync(path.join(path.dirname(root), 'pwned.txt'))).toBe(false);
      expect(fs.readFileSync(path.join(root, 'good.txt'), 'utf8')).toBe('safe');
    });
  });

  describe('createExportStream', () => {
    /** Collects a whole stream into a single Buffer. */
    function drain(stream: Readable): Promise<Buffer> {
      return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
      });
    }

    it('produces a readable tar.gz containing the stored files', async () => {
      await service.putFile('a.txt', Buffer.from('alpha'));
      await service.putFile('nested/b.txt', Buffer.from('beta'));

      const gz = await drain(await service.createExportStream());

      // Must be real gzip data, not an empty/failed stream.
      expect(() => zlib.gunzipSync(gz)).not.toThrow();

      const contents = await extractEntries(gz);
      expect(Object.keys(contents).sort()).toEqual(['a.txt', 'nested/b.txt']);
      expect(contents['a.txt']).toBe('alpha');
      expect(contents['nested/b.txt']).toBe('beta');
    });

    it('skips unreadable files instead of aborting the whole export', async () => {
      await service.putFile('good.txt', Buffer.from('safe'));
      await service.putFile('doomed.txt', Buffer.from('will fail'));

      const originalGet = service.getFile.bind(service);
      jest.spyOn(service, 'getFile').mockImplementation(file => {
        if (file === 'doomed.txt') throw new Error('EIO');
        return originalGet(file);
      });

      const gz = await drain(await service.createExportStream());

      // The archive is still valid and contains the file that did work.
      expect(() => zlib.gunzipSync(gz)).not.toThrow();
      const contents = await extractEntries(gz);
      expect(contents['good.txt']).toBe('safe');
      expect(contents['doomed.txt']).toBeUndefined();
    });
  });
});
