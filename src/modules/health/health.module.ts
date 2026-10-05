import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/**
 * No imports required: `TypeOrmModule.forRootAsync({ name: 'main' | 'data' })` registers
 * the named DataSource providers globally, and `CacheModule` is `@Global()`.
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
