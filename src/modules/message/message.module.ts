import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MessageService } from './message.service';
import { BulkMessageService } from './bulk-message.service';
import { ScheduledMessageDispatcher } from './scheduled-message.dispatcher';
import { MessageController } from './message.controller';
import { SessionModule } from '../session/session.module';
import { Message } from './entities/message.entity';
import { MessageBatch } from './entities/message-batch.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Message, MessageBatch], 'data'), SessionModule],
  controllers: [MessageController],
  providers: [MessageService, BulkMessageService, ScheduledMessageDispatcher],
  exports: [MessageService, BulkMessageService],
})
export class MessageModule {}
