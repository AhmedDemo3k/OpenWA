import { Controller, Get, Post, Put, Delete, Param, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { WebhookService } from './webhook.service';
import { CreateWebhookDto, UpdateWebhookDto, WebhookResponseDto, WebhookDeliveryDto } from './dto';
import { Webhook } from './entities/webhook.entity';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('webhooks')
@Controller('sessions/:sessionId/webhooks')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  @Post()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Create a webhook for the session' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({
    status: 201,
    description: 'Webhook created',
    type: WebhookResponseDto,
  })
  async create(@Param('sessionId') sessionId: string, @Body() dto: CreateWebhookDto): Promise<Webhook> {
    return this.webhookService.create(sessionId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List all webhooks for a session' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'List of webhooks',
    type: [WebhookResponseDto],
  })
  async findBySession(@Param('sessionId') sessionId: string): Promise<Webhook[]> {
    return this.webhookService.findBySession(sessionId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a webhook by ID' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Webhook ID' })
  @ApiResponse({
    status: 200,
    description: 'Webhook details',
    type: WebhookResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  async findOne(@Param('id') id: string): Promise<Webhook> {
    return this.webhookService.findOne(id);
  }

  @Put(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Update a webhook' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Webhook ID' })
  @ApiResponse({
    status: 200,
    description: 'Webhook updated',
    type: WebhookResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  async update(@Param('id') id: string, @Body() dto: UpdateWebhookDto): Promise<Webhook> {
    return this.webhookService.update(id, dto);
  }

  @Post(':id/test')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Test a webhook by sending a test payload' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Webhook ID' })
  @ApiResponse({ status: 200, description: 'Test result' })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  async test(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
  ): Promise<{ success: boolean; statusCode?: number; error?: string }> {
    return this.webhookService.test(sessionId, id);
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a webhook' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Webhook ID' })
  @ApiResponse({ status: 204, description: 'Webhook deleted' })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  async delete(@Param('id') id: string): Promise<void> {
    return this.webhookService.delete(id);
  }

  @Get(':id/deliveries/failed')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'List dead-lettered (retry-exhausted) deliveries for a webhook' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Webhook ID' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max number of failed deliveries (default 50, max 500)' })
  @ApiResponse({ status: 200, description: 'List of dead-lettered deliveries', type: [WebhookDeliveryDto] })
  @ApiResponse({ status: 400, description: 'Webhook queue disabled' })
  async listDeadLetters(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ): Promise<WebhookDeliveryDto[]> {
    const parsed = limit ? Number.parseInt(limit, 10) : undefined;
    return this.webhookService.listDeadLetters(sessionId, id, parsed && Number.isFinite(parsed) ? parsed : undefined);
  }

  @Post(':id/deliveries/:jobId/retry')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Requeue a dead-lettered delivery for a fresh retry' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Webhook ID' })
  @ApiParam({ name: 'jobId', description: 'BullMQ job id from the failed deliveries list' })
  @ApiResponse({ status: 200, description: 'Delivery requeued' })
  @ApiResponse({ status: 404, description: 'Webhook or delivery not found' })
  async retryDeadLetter(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Param('jobId') jobId: string,
  ): Promise<{ jobId: string; retried: true }> {
    return this.webhookService.retryDeadLetter(sessionId, id, jobId);
  }

  @Delete(':id/deliveries/:jobId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Discard a dead-lettered delivery permanently' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Webhook ID' })
  @ApiParam({ name: 'jobId', description: 'BullMQ job id from the failed deliveries list' })
  @ApiResponse({ status: 200, description: 'Delivery discarded' })
  @ApiResponse({ status: 404, description: 'Webhook or delivery not found' })
  async removeDeadLetter(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Param('jobId') jobId: string,
  ): Promise<{ jobId: string; removed: true }> {
    return this.webhookService.removeDeadLetter(sessionId, id, jobId);
  }
}
