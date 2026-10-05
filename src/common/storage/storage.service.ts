import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as archiver from 'archiver';
import * as tar from 'tar-stream';
import { createGunzip } from 'zlib';
import { Readable, PassThrough, pipeline } from 'stream';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { createLogger } from '../services/logger.service';

interface S3Config {
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  bucket?: string;
}

@Injectable()
export class StorageService {
  private readonly logger = createLogger('StorageService');
  private readonly storageType: string;
  private readonly localPath: string;
  private s3Client: S3Client | null = null;
  private s3Bucket = 'openwa';
  private s3Available = false;

  constructor(private readonly configService: ConfigService) {
    this.storageType = this.configService.get<string>('storage.type') || 'local';
    this.localPath = this.configService.get<string>('storage.localPath') || './data/media';

    // Initialize S3 client if storage type is s3
    if (this.storageType === 's3') {
      const s3Config = this.configService.get<S3Config>('storage.s3') || {};
      const endpoint = process.env.S3_ENDPOINT || s3Config.endpoint;
      const accessKeyId = process.env.S3_ACCESS_KEY || s3Config.accessKeyId;
      const secretAccessKey = process.env.S3_SECRET_KEY || s3Config.secretAccessKey;
      const region = process.env.S3_REGION || s3Config.region || 'us-east-1';

      if (endpoint && accessKeyId && secretAccessKey) {
        this.s3Client = new S3Client({
          endpoint,
          region,
          credentials: {
            accessKeyId,
            secretAccessKey,
          },
          forcePathStyle: true, // Required for MinIO
        });
        this.s3Bucket = process.env.S3_BUCKET || s3Config.bucket || 'openwa';
        void this.initializeS3Bucket();
      }
    }

    // Ensure local directory exists
    if (!fs.existsSync(this.localPath)) {
      fs.mkdirSync(this.localPath, { recursive: true });
    }
  }

  private async initializeS3Bucket(): Promise<void> {
    if (!this.s3Client) return;

    try {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: this.s3Bucket }));
      this.s3Available = true;
      this.logger.log(`S3 bucket '${this.s3Bucket}' is available`);
    } catch (error: unknown) {
      const err = error as { name?: string };
      if (err.name === 'NotFound' || err.name === 'NoSuchBucket') {
        // Create bucket
        try {
          await this.s3Client.send(new CreateBucketCommand({ Bucket: this.s3Bucket }));
          this.s3Available = true;
          this.logger.log(`Created S3 bucket '${this.s3Bucket}'`);
        } catch (createError) {
          this.logger.error('Failed to create S3 bucket', String(createError));
        }
      } else {
        this.logger.error('S3 bucket check failed', String(error));
      }
    }
  }

  // ============================================================================
  // Current Storage Operations
  // ============================================================================

  getCurrentStorageType(): string {
    return this.storageType;
  }

  isS3Available(): boolean {
    return this.s3Available;
  }

  async listFiles(): Promise<string[]> {
    if (this.storageType === 's3' && this.s3Client && this.s3Available) {
      return this.listS3Files();
    }
    return this.listLocalFiles();
  }

  async getFile(filePath: string): Promise<Buffer> {
    if (this.storageType === 's3' && this.s3Client && this.s3Available) {
      return this.getS3File(filePath);
    }
    return this.getLocalFile(filePath);
  }

  async putFile(filePath: string, data: Buffer): Promise<void> {
    if (this.storageType === 's3' && this.s3Client && this.s3Available) {
      return this.putS3File(filePath, data);
    }
    return this.putLocalFile(filePath, data);
  }

  async getFileCount(): Promise<{ count: number; sizeBytes: number }> {
    const files = await this.listFiles();
    let sizeBytes = 0;

    if (this.storageType === 's3' && this.s3Client && this.s3Available) {
      // S3 size would require additional API calls, estimate
      sizeBytes = files.length * 100000; // Estimate 100KB per file
    } else {
      for (const file of files) {
        try {
          const fullPath = this.resolveLocalPath(file);
          const stats = fs.statSync(fullPath);
          sizeBytes += stats.size;
        } catch (error) {
          this.logger.debug(`Failed to stat file: ${file}`, { error: String(error) });
        }
      }
    }

    return { count: files.length, sizeBytes };
  }

  // ============================================================================
  // Export - Create tar.gz stream from current storage
  // ============================================================================

  createExportStream(): Promise<PassThrough> {
    const output = new PassThrough();

    const archive = archiver.default('tar', {
      gzip: true,
      gzipOptions: { level: 6 },
    });

    // An archiver failure emits 'error'; with no listener Node turns that into an
    // uncaught exception and kills the process mid-export. Forward it to the consumer.
    archive.on('error', (err: Error) => {
      this.logger.error('Storage export failed', String(err));
      output.destroy(err);
    });

    archive.pipe(output);

    // Populate the archive in the background and hand the stream back immediately.
    // Awaiting every file here filled the PassThrough's 16 KB buffer, after which
    // archiver buffered the entire library in memory while nothing was draining it —
    // an OOM waiting to happen on a real media folder.
    void this.populateArchive(archive);

    return Promise.resolve(output);
  }

  private async populateArchive(archive: archiver.Archiver): Promise<void> {
    try {
      for (const file of await this.listFiles()) {
        try {
          const data = await this.getFile(file);
          archive.append(data, { name: file });
        } catch (error) {
          this.logger.warn(`Failed to export file: ${file}`, { error: String(error) });
        }
      }

      // finalize() returns a promise that rejects on a broken entry; discarding it with
      // `void` turned those into unhandledRejections.
      await archive.finalize();
    } catch (error) {
      this.logger.error('Storage export failed while building the archive', String(error));
      archive.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }

  // ============================================================================
  // Import - Extract tar.gz stream to current storage
  // ============================================================================

  async importFromStream(inputStream: Readable): Promise<number> {
    let importedCount = 0;

    const extract = tar.extract();
    const gunzip = createGunzip();

    return new Promise<number>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };

      extract.on('entry', (header, stream, next) => {
        const chunks: Buffer[] = [];

        // A failed entry must still call next(), otherwise the extractor never advances
        // and the import hangs until the process is killed.
        stream.on('error', (err: Error) => {
          this.logger.error(`Failed to read archive entry: ${header.name}`, String(err));
          next();
        });

        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          void this.safeWriteEntry(header, chunks).then(imported => {
            importedCount += imported;
            next();
          });
        });
        stream.resume();
      });

      extract.on('finish', () => {
        this.logger.log(`Import completed: ${importedCount} files`);
        settle(() => resolve(importedCount));
      });

      // `pipeline` forwards the first error from any stage and destroys all of them.
      // Plain `.pipe()` chains do neither: a corrupt archive made the gunzip stage emit
      // an unhandled 'error' event, which crashed the process, and a client that hung up
      // mid-upload left this promise pending forever.
      pipeline(inputStream, gunzip, extract, err => {
        if (!err) return;
        this.logger.error('Import failed', String(err));
        settle(() => reject(err));
      });
    });
  }

  /** Writes one archive entry, refusing names that would escape the storage root. */
  private async safeWriteEntry(header: { name: string; type?: string }, chunks: Buffer[]): Promise<number> {
    // Directories carry no payload; tar-stream still expects next() for them.
    if (header.type === 'directory') return 0;
    if (header.type === 'link' || header.type === 'symlink') {
      this.logger.warn(`Skipped link entry in archive: ${header.name}`);
      return 0;
    }

    try {
      await this.putFile(header.name, Buffer.concat(chunks));
      this.logger.debug(`Imported file: ${header.name}`);
      return 1;
    } catch (error: unknown) {
      this.logger.error(`Failed to import file: ${header.name}`, String(error));
      return 0;
    }
  }

  // ============================================================================
  // Local Storage Operations
  // ============================================================================

  private listLocalFiles(dir = ''): string[] {
    const fullPath = path.join(this.localPath, dir);
    const files: string[] = [];

    if (!fs.existsSync(fullPath)) {
      return files;
    }

    const entries = fs.readdirSync(fullPath, { withFileTypes: true });

    for (const entry of entries) {
      const relativePath = dir ? path.join(dir, entry.name) : entry.name;

      if (entry.isDirectory()) {
        files.push(...this.listLocalFiles(relativePath));
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }

    return files;
  }

  /**
   * Resolves a caller-supplied relative path inside the storage root, refusing anything
   * that escapes it.
   *
   * `path.join` happily collapses `..` segments, so an imported tar entry named
   * `../../../../etc/cron.d/x` would otherwise be written outside `localPath` — an
   * arbitrary-file-write from any endpoint that accepts an upload.
   */
  private resolveLocalPath(filePath: string): string {
    const root = path.resolve(this.localPath);
    const resolved = path.resolve(root, filePath);

    const isInside = resolved === root || resolved.startsWith(root + path.sep);
    if (!isInside) {
      throw new Error(`Path escapes the storage root: ${filePath}`);
    }
    return resolved;
  }

  private getLocalFile(filePath: string): Promise<Buffer> {
    const fullPath = this.resolveLocalPath(filePath);
    return Promise.resolve(fs.readFileSync(fullPath));
  }

  private putLocalFile(filePath: string, data: Buffer): Promise<void> {
    const fullPath = this.resolveLocalPath(filePath);
    const dir = path.dirname(fullPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(fullPath, data);
    return Promise.resolve();
  }

  // ============================================================================
  // S3 Storage Operations
  // ============================================================================

  private async listS3Files(): Promise<string[]> {
    if (!this.s3Client) return [];

    const files: string[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: this.s3Bucket,
          Prefix: 'media/',
          ContinuationToken: continuationToken,
        }),
      );

      if (response.Contents) {
        for (const obj of response.Contents) {
          if (obj.Key) {
            // Remove 'media/' prefix
            files.push(obj.Key.replace(/^media\//, ''));
          }
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return files;
  }

  private async getS3File(filePath: string): Promise<Buffer> {
    if (!this.s3Client) throw new Error('S3 client not initialized');

    const response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: this.s3Bucket,
        Key: `media/${filePath}`,
      }),
    );

    if (!response.Body) throw new Error('Empty response body');

    // Convert stream to buffer
    const chunks: Buffer[] = [];
    const stream = response.Body as Readable;

    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk as ArrayBuffer));
    }

    return Buffer.concat(chunks);
  }

  private async putS3File(filePath: string, data: Buffer): Promise<void> {
    if (!this.s3Client) throw new Error('S3 client not initialized');

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.s3Bucket,
        Key: `media/${filePath}`,
        Body: data,
      }),
    );
  }
}
