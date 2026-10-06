import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { jsonColumnType, dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

export enum MessageDirection {
  INCOMING = 'incoming',
  OUTGOING = 'outgoing',
}

export enum MessageStatus {
  PENDING = 'pending',
  SCHEDULED = 'scheduled',
  SENDING = 'sending',
  SENT = 'sent',
  DELIVERED = 'delivered',
  READ = 'read',
  FAILED = 'failed',
}

@Entity('messages')
@Index(['sessionId', 'createdAt'])
@Index(['chatId'])
@Index(['status', 'sendAt'])
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  sessionId: string;

  @Column({ nullable: true })
  waMessageId: string;

  @Column()
  chatId: string;

  @Column()
  from: string;

  @Column()
  to: string;

  @Column({ type: 'text', nullable: true })
  body: string;

  @Column({ default: 'text' })
  type: string;

  @Column({
    type: 'varchar',
    default: MessageDirection.OUTGOING,
  })
  direction: MessageDirection;

  @Column({ type: 'bigint', nullable: true })
  timestamp: number;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  sendAt: Date | null;

  @Column({ type: jsonColumnType(), nullable: true })
  metadata: Record<string, unknown>;

  @Column({
    type: 'varchar',
    default: MessageStatus.SENT,
  })
  @Index()
  status: MessageStatus;

  @CreateDateColumn()
  createdAt: Date;
}
