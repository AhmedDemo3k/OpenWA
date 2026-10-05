import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export enum ApiKeyRole {
  ADMIN = 'admin',
  OPERATOR = 'operator',
  VIEWER = 'viewer',
}

@Entity('api_keys')
export class ApiKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  keyHash: string;

  @Column({ type: 'varchar', length: 8 })
  keyPrefix: string;

  @Column({
    type: 'varchar',
    length: 20,
    default: ApiKeyRole.OPERATOR,
  })
  role: ApiKeyRole;

  @Column({ type: 'simple-array', nullable: true })
  allowedIps: string[] | null;

  @Column({ type: 'simple-array', nullable: true })
  allowedSessions: string[] | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'datetime', nullable: true })
  expiresAt: Date | null;

  @Column({ type: 'datetime', nullable: true })
  lastUsedAt: Date | null;

  @Column({ type: 'int', default: 0 })
  usageCount: number;

  /**
   * Requests allowed inside `rateLimitWindowSeconds`, or null to inherit the global limits
   * from RATE_LIMIT_MEDIUM_LIMIT and friends.
   *
   * Buckets are keyed per API key, so the limit is per key rather than per address. That
   * matters here because every request arrives through the Tailscale funnel from the same
   * host address: a shared IP bucket meant one noisy client throttled everyone else.
   */
  @Column({ type: 'int', nullable: true })
  rateLimit: number | null;

  /** Window that `rateLimit` is counted over. Ignored when `rateLimit` is null. */
  @Column({ type: 'int', nullable: true })
  rateLimitWindowSeconds: number | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
