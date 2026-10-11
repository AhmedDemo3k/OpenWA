import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Webhook } from './webhook.entity';
import { jsonColumnType } from '../../../common/utils/column-types';

@Entity('webhook_delivery_logs')
export class WebhookDeliveryLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  webhookId: string;

  @ManyToOne(() => Webhook, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'webhookId' })
  webhook: Webhook;

  @Column({ type: 'varchar', length: 50 })
  event: string;

  @Column({ type: 'varchar', length: 100 })
  deliveryId: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  idempotencyKey: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  jobId: string | null;

  @Column({ type: 'boolean' })
  success: boolean;

  @Column({ type: 'int', nullable: true })
  statusCode: number | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ type: 'int', nullable: true })
  responseTimeMs: number | null;

  @Column({ type: 'int', nullable: true })
  attempt: number | null;

  @Column({ type: jsonColumnType(), default: '{}' })
  headers: Record<string, string>;

  @Column({ type: jsonColumnType(), default: '{}' })
  meta: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;
}
