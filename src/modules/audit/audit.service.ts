import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThan } from 'typeorm';
import { EventEmitter } from 'events';
import { AuditLog, AuditAction, AuditSeverity } from './entities/audit-log.entity';
import { ApiKey } from '../auth/entities/api-key.entity';

interface AuditContext {
  apiKey?: ApiKey;
  sessionId?: string;
  sessionName?: string;
  ipAddress?: string;
  userAgent?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  metadata?: Record<string, unknown>;
  errorMessage?: string;
}

export interface AuditQueryOptions {
  action?: AuditAction;
  apiKeyId?: string;
  sessionId?: string;
  severity?: AuditSeverity;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

@Injectable()
export class AuditService {
  /**
   * Fan-out for newly created audit logs. The SSE endpoint subscribes here so live clients
   * get entries as soon as they are persisted, without polling the table.
   */
  private readonly events = new EventEmitter();

  constructor(
    @InjectRepository(AuditLog, 'main')
    private readonly auditRepository: Repository<AuditLog>,
  ) {
    // The default of 10 listeners would cap the number of concurrent live-log viewers.
    this.events.setMaxListeners(100);
  }

  async log(
    action: AuditAction,
    context: AuditContext = {},
    severity: AuditSeverity = AuditSeverity.INFO,
  ): Promise<AuditLog> {
    const auditLog = this.auditRepository.create({
      action,
      severity,
      apiKeyId: context.apiKey?.id || null,
      apiKeyName: context.apiKey?.name || null,
      sessionId: context.sessionId || null,
      sessionName: context.sessionName || null,
      ipAddress: context.ipAddress || null,
      userAgent: context.userAgent || null,
      method: context.method || null,
      path: context.path || null,
      statusCode: context.statusCode || null,
      metadata: context.metadata || null,
      errorMessage: context.errorMessage || null,
    });

    const saved = await this.auditRepository.save(auditLog);
    this.publish(saved);
    return saved;
  }

  /**
   * Subscribes to newly created audit logs. Returns an unsubscribe function.
   */
  onLog(handler: (log: AuditLog) => void): () => void {
    this.events.on('audit:created', handler);
    return () => {
      this.events.off('audit:created', handler);
    };
  }

  private publish(log: AuditLog): void {
    this.events.emit('audit:created', log);
  }

  async logInfo(action: AuditAction, context: AuditContext = {}): Promise<AuditLog> {
    return this.log(action, context, AuditSeverity.INFO);
  }

  async logWarn(action: AuditAction, context: AuditContext = {}): Promise<AuditLog> {
    return this.log(action, context, AuditSeverity.WARN);
  }

  async logError(action: AuditAction, context: AuditContext = {}): Promise<AuditLog> {
    return this.log(action, context, AuditSeverity.ERROR);
  }

  async findAll(options: AuditQueryOptions = {}): Promise<{
    data: AuditLog[];
    total: number;
  }> {
    const where: Record<string, unknown> = {};

    if (options.action) where.action = options.action;
    if (options.apiKeyId) where.apiKeyId = options.apiKeyId;
    if (options.sessionId) where.sessionId = options.sessionId;
    if (options.severity) where.severity = options.severity;

    if (options.startDate && options.endDate) {
      where.createdAt = Between(options.startDate, options.endDate);
    }

    const [data, total] = await this.auditRepository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      take: options.limit || 50,
      skip: options.offset || 0,
    });

    return { data, total };
  }

  async getRecentByApiKey(apiKeyId: string, limit = 10): Promise<AuditLog[]> {
    return this.auditRepository.find({
      where: { apiKeyId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async getRecentBySession(sessionId: string, limit = 10): Promise<AuditLog[]> {
    return this.auditRepository.find({
      where: { sessionId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async cleanup(olderThanDays = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    const result = await this.auditRepository.delete({
      createdAt: LessThan(cutoffDate),
    });

    return result.affected || 0;
  }
}
