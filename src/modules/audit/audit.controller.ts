import { Controller, Get, Query, Sse } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { Observable } from 'rxjs';
import { AuditService, AuditQueryOptions } from './audit.service';
import { AuditLog, AuditAction, AuditSeverity } from './entities/audit-log.entity';

@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @ApiOperation({ summary: 'List audit logs with optional filters' })
  @ApiQuery({ name: 'action', required: false, enum: AuditAction })
  @ApiQuery({ name: 'severity', required: false, enum: AuditSeverity })
  @ApiQuery({ name: 'sessionId', required: false })
  @ApiQuery({ name: 'apiKeyId', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of audit logs',
  })
  async findAll(
    @Query('action') action?: AuditAction,
    @Query('severity') severity?: AuditSeverity,
    @Query('sessionId') sessionId?: string,
    @Query('apiKeyId') apiKeyId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ data: AuditLog[]; total: number }> {
    const options: AuditQueryOptions = {};
    if (action) options.action = action;
    if (severity) options.severity = severity;
    if (sessionId) options.sessionId = sessionId;
    if (apiKeyId) options.apiKeyId = apiKeyId;
    if (limit) options.limit = parseInt(limit, 10);
    if (offset) options.offset = parseInt(offset, 10);

    return this.auditService.findAll(options);
  }

  /**
   * Server-Sent Events stream of newly created audit logs.
   *
   * The client is expected to drive this with fetch() so it can send the X-API-Key header
   * (EventSource cannot set headers). A heartbeat frame keeps the connection open through
   * proxies with idle timeouts; clients should ignore empty `data` frames.
   */
  @Sse('stream')
  @ApiOperation({ summary: 'Stream new audit logs over Server-Sent Events' })
  @ApiResponse({ status: 200, description: 'Server-Sent Events stream of audit logs' })
  streamLogs(): Observable<{ data: AuditLog | '' }> {
    return new Observable<{ data: AuditLog | '' }>(subscriber => {
      const unsubscribe = this.auditService.onLog(log => {
        subscriber.next({ data: log });
      });

      const heartbeat = setInterval(() => {
        subscriber.next({ data: '' });
      }, 15_000);
      heartbeat.unref?.();

      return () => {
        unsubscribe();
        clearInterval(heartbeat);
      };
    });
  }
}
