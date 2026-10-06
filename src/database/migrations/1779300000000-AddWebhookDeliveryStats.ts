import { MigrationInterface, QueryRunner } from 'typeorm';

const COLUMNS = [
  'lastSuccessAt',
  'lastFailureAt',
  'lastAttemptAt',
  'lastStatusCode',
  'lastError',
  'consecutiveFailures',
] as const;

export class AddWebhookDeliveryStats1779300000000 implements MigrationInterface {
  name = 'AddWebhookDeliveryStats1779300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    const dateType = isPostgres ? 'timestamp' : 'datetime';
    // SQLite default-value syntax wraps the literal in parentheses.
    const defaultNum = isPostgres ? '0' : '(0)';

    await queryRunner.query(`ALTER TABLE "webhooks" ADD "lastSuccessAt" ${dateType}`);
    await queryRunner.query(`ALTER TABLE "webhooks" ADD "lastFailureAt" ${dateType}`);
    await queryRunner.query(`ALTER TABLE "webhooks" ADD "lastAttemptAt" ${dateType}`);
    await queryRunner.query(`ALTER TABLE "webhooks" ADD "lastStatusCode" integer`);
    await queryRunner.query(`ALTER TABLE "webhooks" ADD "lastError" text`);
    await queryRunner.query(`ALTER TABLE "webhooks" ADD "consecutiveFailures" integer NOT NULL DEFAULT ${defaultNum}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const column of COLUMNS) {
      await queryRunner.query(`ALTER TABLE "webhooks" DROP COLUMN "${column}"`);
    }
  }
}
