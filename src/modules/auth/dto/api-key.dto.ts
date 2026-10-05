import {
  IsString,
  IsOptional,
  IsEnum,
  IsArray,
  IsDateString,
  IsInt,
  Min,
  Max,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiKeyRole } from '../entities/api-key.entity';

export class CreateApiKeyDto {
  @ApiProperty({
    description: 'Friendly name for the API key',
    example: 'Production Bot',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({
    description: 'Role/permission level',
    enum: ApiKeyRole,
    default: ApiKeyRole.OPERATOR,
  })
  @IsOptional()
  @IsEnum(ApiKeyRole)
  role?: ApiKeyRole;

  @ApiPropertyOptional({
    description: 'Allowed IP addresses (whitelist)',
    example: ['192.168.1.1', '10.0.0.0/8'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedIps?: string[];

  @ApiPropertyOptional({
    description: 'Allowed session IDs this key can access',
    example: ['session-uuid-1', 'session-uuid-2'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedSessions?: string[];

  @ApiPropertyOptional({
    description: 'Expiration date (ISO 8601)',
    example: '2027-12-31T23:59:59Z',
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiPropertyOptional({
    description:
      'Requests allowed inside the window. Counted per key, not per address, so one client ' +
      'cannot throttle another. Omit or pass null to inherit RATE_LIMIT_MEDIUM_LIMIT.',
    example: 300,
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  rateLimit?: number | null;

  @ApiPropertyOptional({
    description: 'Window that rateLimit is counted over. Defaults to 60 seconds.',
    example: 60,
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(86_400)
  rateLimitWindowSeconds?: number | null;
}

export class ApiKeyResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({
    description: 'First 8 characters of the key (for identification)',
  })
  keyPrefix: string;

  @ApiProperty({ enum: ApiKeyRole })
  role: ApiKeyRole;

  @ApiPropertyOptional()
  allowedIps?: string[];

  @ApiPropertyOptional()
  allowedSessions?: string[];

  @ApiProperty()
  isActive: boolean;

  @ApiPropertyOptional()
  expiresAt?: Date;

  @ApiPropertyOptional()
  lastUsedAt?: Date;

  @ApiProperty()
  usageCount: number;

  @ApiPropertyOptional({
    description: 'Per-key request limit, or null when the global limits apply',
    nullable: true,
  })
  rateLimit: number | null;

  @ApiPropertyOptional({ nullable: true })
  rateLimitWindowSeconds: number | null;

  @ApiProperty()
  createdAt: Date;
}

export class ApiKeyCreatedResponseDto extends ApiKeyResponseDto {
  @ApiProperty({
    description: 'Full API key (only shown once at creation)',
    example: 'owa_k1_abc123...',
  })
  apiKey: string;
}

export class UpdateApiKeyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ enum: ApiKeyRole })
  @IsOptional()
  @IsEnum(ApiKeyRole)
  role?: ApiKeyRole;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedIps?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedSessions?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiPropertyOptional({
    description: 'Pass null to clear the per-key override and fall back to the global limits',
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  rateLimit?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(86_400)
  rateLimitWindowSeconds?: number | null;
}
