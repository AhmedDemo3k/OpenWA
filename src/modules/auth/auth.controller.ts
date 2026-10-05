import { Controller, Get, Post, Put, Delete, Body, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { CreateApiKeyDto, UpdateApiKeyDto, ApiKeyResponseDto, ApiKeyCreatedResponseDto } from './dto';
import { RequireRole } from './decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';

@ApiTags('auth')
@ApiBearerAuth()
@Controller('auth/api-keys')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Single projection from the entity to the response shape.
   *
   * This mapping was repeated at five call sites, which meant every field added to
   * `ApiKey` had to be added five times or the build broke. `rateLimit` was the field that
   * proved it.
   */
  private toResponse(key: ApiKey): ApiKeyResponseDto {
    return {
      id: key.id,
      name: key.name,
      keyPrefix: key.keyPrefix,
      role: key.role,
      allowedIps: key.allowedIps || undefined,
      allowedSessions: key.allowedSessions || undefined,
      isActive: key.isActive,
      expiresAt: key.expiresAt || undefined,
      lastUsedAt: key.lastUsedAt || undefined,
      usageCount: key.usageCount,
      rateLimit: key.rateLimit ?? null,
      rateLimitWindowSeconds: key.rateLimitWindowSeconds ?? null,
      createdAt: key.createdAt,
    };
  }

  @Post()
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Create a new API key (admin only)' })
  @ApiResponse({
    status: 201,
    description: 'API key created',
    type: ApiKeyCreatedResponseDto,
  })
  async create(@Body() dto: CreateApiKeyDto): Promise<ApiKeyCreatedResponseDto> {
    const { apiKey, rawKey } = await this.authService.createApiKey(dto);
    return {
      ...this.toResponse(apiKey),
      apiKey: rawKey,
    };
  }

  @Get()
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'List all API keys (admin only)' })
  @ApiResponse({ status: 200, type: [ApiKeyResponseDto] })
  async findAll(): Promise<ApiKeyResponseDto[]> {
    const keys = await this.authService.findAll();
    return keys.map(key => this.toResponse(key));
  }

  @Get(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Get API key details (admin only)' })
  @ApiResponse({ status: 200, type: ApiKeyResponseDto })
  async findOne(@Param('id') id: string): Promise<ApiKeyResponseDto> {
    return this.toResponse(await this.authService.findOne(id));
  }

  @Put(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Update API key (admin only)' })
  @ApiResponse({ status: 200, type: ApiKeyResponseDto })
  async update(@Param('id') id: string, @Body() dto: UpdateApiKeyDto): Promise<ApiKeyResponseDto> {
    return this.toResponse(await this.authService.update(id, dto));
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete API key (admin only)' })
  @ApiResponse({ status: 204, description: 'API key deleted' })
  async delete(@Param('id') id: string): Promise<void> {
    await this.authService.delete(id);
  }

  @Post(':id/revoke')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Revoke API key (admin only)' })
  @ApiResponse({ status: 200, type: ApiKeyResponseDto })
  async revoke(@Param('id') id: string): Promise<ApiKeyResponseDto> {
    return this.toResponse(await this.authService.revoke(id));
  }
}
