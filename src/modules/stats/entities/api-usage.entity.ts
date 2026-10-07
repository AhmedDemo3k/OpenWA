import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';

/**
 * Daily per-day API request counter backing the dashboard's "API calls" stat.
 *
 * The modal in-memory view of the request count is a dashboard nicety, so it must never
 * take the API down: every read/write in ApiUsageService is best-effort and swallowed.
 */
@Entity('api_usage')
@Index(['date'], { unique: true })
export class ApiUsage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 10 })
  date: string;

  @Column({ type: 'int', default: 0 })
  requests: number;
}
