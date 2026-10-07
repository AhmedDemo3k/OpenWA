import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';
import { ApiUsageService } from './api-usage.service';
import { ApiUsageInterceptor } from './api-usage.interceptor';
import { ApiUsage } from './entities/api-usage.entity';
import { Session } from '../session/entities/session.entity';
import { Message } from '../message/entities/message.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Session, Message, ApiUsage], 'data')],
  controllers: [StatsController],
  providers: [StatsService, ApiUsageService, { provide: APP_INTERCEPTOR, useClass: ApiUsageInterceptor }],
  exports: [StatsService],
})
export class StatsModule {}
