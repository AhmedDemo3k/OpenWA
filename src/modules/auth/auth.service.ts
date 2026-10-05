import { Injectable, NotFoundException, UnauthorizedException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash, randomBytes } from 'crypto';
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { CreateApiKeyDto, UpdateApiKeyDto } from './dto';
import { createLogger } from '../../common/services/logger.service';

const DEV_API_KEY = 'dev-admin-key';

/**
 * Refuse to auto-rotate away a working key when this looks like an unattended restart.
 *
 * Rotation replaces the credential the caller is currently using, so it is only safe when a
 * human can read the banner and store the new secret: interactively, or through a process
 * supervisor whose stdout lands in a log we can point at.
 *
 * A crash-loop under Docker/systemd is the dangerous case. The container comes back up
 * seconds after the rotation and no one reads the log, so the printed key is lost and the
 * admin is locked out with no way in but the database. Observability is therefore a
 * precondition for rotating, not a nice-to-have.
 */
function canRotateKeySafely(): boolean {
  if (process.env.AUTH_AUTO_ROTATE_DEV_KEY === 'true') return true;
  if (process.env.AUTH_AUTO_ROTATE_DEV_KEY === 'false') return false;
  return Boolean(process.stdout.isTTY) || Boolean(process.env.AUTH_KEY_FILE);
}

/**
 * Where the raw key gets written so it survives the process.
 *
 * Defaults to a `data/` subdirectory so container restart policies do not silently reset it.
 */
function apiKeyFilePath(): string {
  return process.env.AUTH_KEY_FILE || join(process.cwd(), 'data', '.api-key');
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = createLogger('AuthService');

  constructor(
    @InjectRepository(ApiKey, 'main')
    private readonly apiKeyRepository: Repository<ApiKey>,
  ) {}

  async onModuleInit(): Promise<void> {
    // Seed a default API key if none exist
    const count = await this.apiKeyRepository.count();
    const isProduction = process.env.NODE_ENV === 'production';
    let displayKey: string;
    let isNewKey = false;

    if (count === 0) {
      // Use predictable key in development, random key in production
      displayKey = isProduction ? this.generateKey() : DEV_API_KEY;

      await this.seedApiKey(displayKey, 'Default Admin Key', ApiKeyRole.ADMIN);
      isNewKey = true;

      this.persistKeyFile(displayKey);
    } else {
      const rotation = await this.reconcileDevelopmentKey(isProduction);

      if (rotation.rotated) {
        displayKey = rotation.rawKey!;
        isNewKey = true;
      } else {
        displayKey = await this.readKeyFile();
      }
    }

    // Always show the welcome banner on startup
    const apiBaseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 2785}`;
    const dashboardUrl = process.env.DASHBOARD_URL || `http://localhost:${process.env.DASHBOARD_PORT || 2886}`;

    this.logger.log('');
    this.logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    this.logger.log('');
    this.logger.log('  🟢 Welcome to OpenWA - WhatsApp API Gateway');
    this.logger.log('');
    this.logger.log(`  📊 Dashboard: ${dashboardUrl}`);
    this.logger.log(`  📚 API Docs:  ${apiBaseUrl}/api/docs`);
    this.logger.log('');
    if (isNewKey) {
      this.logger.log('  🔑 API Key (newly created):');
    } else {
      this.logger.log('  🔑 API Key:');
    }
    this.logger.log(`     ${displayKey}`);
    this.logger.log('');
    this.logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    this.logger.log('');
  }

  private async seedApiKey(rawKey: string, name: string, role: ApiKeyRole): Promise<ApiKey> {
    const keyHash = this.hashKey(rawKey);
    const keyPrefix = rawKey.substring(0, 12);

    const apiKey = this.apiKeyRepository.create({
      name,
      keyHash,
      keyPrefix,
      role,
    });

    return this.apiKeyRepository.save(apiKey);
  }

  async createApiKey(dto: CreateApiKeyDto): Promise<{ apiKey: ApiKey; rawKey: string }> {
    const rawKey = this.generateKey();
    const keyHash = this.hashKey(rawKey);
    const keyPrefix = rawKey.substring(0, 12);

    const apiKey = this.apiKeyRepository.create({
      name: dto.name,
      keyHash,
      keyPrefix,
      role: dto.role || ApiKeyRole.OPERATOR,
      allowedIps: dto.allowedIps || null,
      allowedSessions: dto.allowedSessions || null,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
    });

    const saved = await this.apiKeyRepository.save(apiKey);
    this.logger.log(`API key created: ${saved.name}`, {
      keyId: saved.id,
      role: saved.role,
      action: 'api_key_created',
    });

    return { apiKey: saved, rawKey };
  }

  async findAll(): Promise<ApiKey[]> {
    return this.apiKeyRepository.find({
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<ApiKey> {
    const apiKey = await this.apiKeyRepository.findOne({ where: { id } });
    if (!apiKey) {
      throw new NotFoundException(`API key with id '${id}' not found`);
    }
    return apiKey;
  }

  async update(id: string, dto: UpdateApiKeyDto): Promise<ApiKey> {
    const apiKey = await this.findOne(id);

    if (dto.name) apiKey.name = dto.name;
    if (dto.role) apiKey.role = dto.role;
    if (dto.allowedIps !== undefined) apiKey.allowedIps = dto.allowedIps;
    if (dto.allowedSessions !== undefined) apiKey.allowedSessions = dto.allowedSessions;
    if (dto.expiresAt !== undefined) apiKey.expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;

    return this.apiKeyRepository.save(apiKey);
  }

  async delete(id: string): Promise<void> {
    const apiKey = await this.findOne(id);
    await this.apiKeyRepository.remove(apiKey);
    this.logger.log(`API key deleted: ${apiKey.name}`, {
      keyId: id,
      action: 'api_key_deleted',
    });
  }

  async revoke(id: string): Promise<ApiKey> {
    const apiKey = await this.findOne(id);
    apiKey.isActive = false;
    return this.apiKeyRepository.save(apiKey);
  }

  async validateApiKey(rawKey: string, clientIp?: string, sessionId?: string): Promise<ApiKey> {
    const keyHash = this.hashKey(rawKey);
    const apiKey = await this.apiKeyRepository.findOne({ where: { keyHash } });

    if (!apiKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    if (!apiKey.isActive) {
      throw new UnauthorizedException('API key is revoked');
    }

    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      throw new UnauthorizedException('API key has expired');
    }

    // Check IP whitelist
    if (apiKey.allowedIps && apiKey.allowedIps.length > 0 && clientIp) {
      if (!this.isIpAllowed(clientIp, apiKey.allowedIps)) {
        this.logger.warn(`IP not allowed: ${clientIp}`, {
          keyId: apiKey.id,
          action: 'ip_rejected',
        });
        throw new UnauthorizedException('IP address not allowed');
      }
    }

    // Check session restriction
    if (apiKey.allowedSessions && apiKey.allowedSessions.length > 0 && sessionId) {
      if (!apiKey.allowedSessions.includes(sessionId)) {
        throw new UnauthorizedException('API key not authorized for this session');
      }
    }

    // Update usage stats
    apiKey.lastUsedAt = new Date();
    apiKey.usageCount += 1;
    await this.apiKeyRepository.save(apiKey);

    return apiKey;
  }

  private generateKey(): string {
    // 32 bytes of CSPRNG entropy, hex-encoded: owa_k1_<64 hex chars>
    return `owa_k1_${randomBytes(32).toString('hex')}`;
  }

  private hashKey(rawKey: string): string {
    return createHash('sha256').update(rawKey).digest('hex');
  }

  private persistKeyFile(rawKey: string): void {
    const target = apiKeyFilePath();
    try {
      // writeFileSync does not create parent directories, so an AUTH_KEY_FILE pointing at a
      // fresh path would fail silently and lose the only copy of a freshly generated secret.
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, rawKey, 'utf-8');
    } catch (err) {
      this.logger.warn('Could not save API key file', { error: String(err) });
    }
  }

  /**
   * Read the last key we printed, but never hand back a secret that no longer works.
   *
   * The file is written once at seed time and is not updated when a key is deleted or
   * rotated, so it drifts out of sync. Printing a stale secret makes the banner actively
   * misleading -- it shows a credential that gets 401 -- so we only echo a file whose hash
   * still matches a live key in the database.
   */
  private async readKeyFile(): Promise<string> {
    if (!existsSync(apiKeyFilePath())) {
      return '(check dashboard for keys)';
    }

    let rawKey: string;
    try {
      rawKey = readFileSync(apiKeyFilePath(), 'utf-8').trim();
    } catch (error) {
      this.logger.warn(`Failed to read API key file: ${apiKeyFilePath()}`, { error: String(error) });
      return '(check dashboard for keys)';
    }

    const match = await this.apiKeyRepository.findOne({
      where: { keyHash: this.hashKey(rawKey), isActive: true },
    });

    if (!match) {
      this.logger.warn('Saved API key file does not match any active key; not displaying it', {
        action: 'api_key_file_stale',
      });
      return '(check dashboard for keys)';
    }

    return rawKey;
  }

  /**
   * Remove the well-known development key if we are running in production.
   *
   * `onModuleInit` only seeds when the table is empty, so a database that was ever touched
   * in development kept `dev-admin-key` alive forever. Promoting that same database to
   * production -- the normal path when staging and production share a volume, or when the
   * seed file is committed -- published a credential that is in every public repository. The
   * NODE_ENV check reading "random key in production" was true only for a fresh database.
   *
   * The key is matched by hash, never by name: the name is operator-editable, so renaming
   * "Default Admin Key" must not be enough to make a leaked credential look legitimate.
   */
  private async reconcileDevelopmentKey(isProduction: boolean): Promise<{ rotated: boolean; rawKey?: string }> {
    if (!isProduction) {
      return { rotated: false };
    }

    const devHash = this.hashKey(DEV_API_KEY);
    const leaked = await this.apiKeyRepository.find({ where: { keyHash: devHash } });

    if (leaked.length === 0) {
      return { rotated: false };
    }

    const ids = leaked.map(key => key.id);

    if (!canRotateKeySafely()) {
      // Loud, and on every boot, but non-destructive. Refusing to start would be safer still,
      // however it turns a recoverable misconfiguration into an outage, so we do not.
      this.logger.error(
        `Development API key '${DEV_API_KEY}' is active in production. Anyone can authenticate with it. ` +
          'Delete it now: DELETE /api/auth/api-keys/:id  -- or set AUTH_AUTO_ROTATE_DEV_KEY=true and ' +
          'AUTH_KEY_FILE to a durable path so a strong key can be generated and written somewhere readable.',
        undefined,
        {
          action: 'dev_key_in_production',
          affected: ids.length,
          keyIds: ids,
        },
      );
      return { rotated: false };
    }

    const replacement = this.generateKey();
    await this.seedApiKey(replacement, 'Default Admin Key (rotated)', ApiKeyRole.ADMIN);
    await this.apiKeyRepository.remove(leaked);

    this.persistKeyFile(replacement);

    this.logger.warn(`Rotated the development API key out of production (${leaked.length} removed)`, {
      action: 'dev_key_rotated',
      affected: leaked.length,
    });

    return { rotated: true, rawKey: replacement };
  }

  private isIpAllowed(clientIp: string, allowedIps: string[]): boolean {
    // Phase 3 Security Audit: Support both exact match and CIDR notation
    for (const entry of allowedIps) {
      if (entry.includes('/')) {
        // CIDR notation (e.g., "10.0.0.0/24")
        if (this.ipInCidr(clientIp, entry)) {
          return true;
        }
      } else {
        // Exact match
        if (clientIp === entry) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Check if an IPv4 address is within a CIDR range
   * @param ip - Client IP address (e.g., "192.168.1.100")
   * @param cidr - CIDR notation (e.g., "192.168.1.0/24")
   */
  private ipInCidr(ip: string, cidr: string): boolean {
    try {
      const [range, bitsStr] = cidr.split('/');
      const bits = parseInt(bitsStr, 10);

      if (isNaN(bits) || bits < 0 || bits > 32) {
        return false;
      }

      const mask = ~(2 ** (32 - bits) - 1);
      const ipNum = this.ipToNumber(ip);
      const rangeNum = this.ipToNumber(range);

      return (ipNum & mask) === (rangeNum & mask);
    } catch (error) {
      this.logger.warn(`Invalid CIDR format: ${cidr}`, { error: String(error) });
      return false;
    }
  }

  /**
   * Convert IPv4 address string to 32-bit number
   */
  private ipToNumber(ip: string): number {
    const parts = ip.split('.');
    if (parts.length !== 4) return 0;

    return parts.reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
  }

  hasPermission(apiKey: ApiKey, requiredRole: ApiKeyRole): boolean {
    const roleHierarchy: Record<ApiKeyRole, number> = {
      [ApiKeyRole.VIEWER]: 1,
      [ApiKeyRole.OPERATOR]: 2,
      [ApiKeyRole.ADMIN]: 3,
    };

    return roleHierarchy[apiKey.role] >= roleHierarchy[requiredRole];
  }
}
