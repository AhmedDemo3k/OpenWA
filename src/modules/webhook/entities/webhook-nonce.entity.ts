import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';

@Entity('webhook_nonces')
export class WebhookNonce {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  nonce: string;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'bigint' })
  expiresAt: number;
}
