import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Webhook hardening (v0.7):
 *  - `webhooks`: pause columns backing the circuit breaker / manual pause.
 *  - `webhook_delivery_logs`: persistent delivery history + idempotency key.
 *  - `webhook_nonces`: single-use nonces for the opt-in replay protection.
 *
 * SQLite installs default to synchronize=true and recreate the schema from the entity, but
 * a DATABASE_SYNCHRONIZE=false SQLite install and Postgres (which never auto-syncs) both
 * need this migration.
 */
export class AddWebhookHardening1780000000000 implements MigrationInterface {
  name = 'AddWebhookHardening1780000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    const dateType = isPostgres ? 'timestamp' : 'datetime';
    const uuidType = isPostgres ? 'uuid' : 'varchar(36)';
    const uuidDefault = isPostgres ? 'uuid_generate_v4()' : '';
    const createdAtDefault = isPostgres ? 'DEFAULT now()' : `DEFAULT (datetime('now'))`;
    const bigintType = isPostgres ? 'bigint' : 'bigint';

    // 1. Pause columns on webhooks
    await queryRunner.query(`ALTER TABLE "webhooks" ADD "paused" boolean NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "webhooks" ADD "pausedAt" ${dateType}`);
    await queryRunner.query(`ALTER TABLE "webhooks" ADD "pauseReason" text`);

    // 2. Delivery log table
    await queryRunner.query(`
      CREATE TABLE "webhook_delivery_logs" (
        "id" ${uuidType} PRIMARY KEY NOT NULL${uuidDefault ? ` DEFAULT ${uuidDefault}` : ''},
        "webhookId" ${uuidType} NOT NULL,
        "event" varchar(50) NOT NULL,
        "deliveryId" varchar(100) NOT NULL,
        "idempotencyKey" varchar(100),
        "jobId" varchar(100),
        "success" boolean NOT NULL,
        "statusCode" integer,
        "error" text,
        "responseTimeMs" integer,
        "attempt" integer,
        "headers" text NOT NULL DEFAULT '{}',
        "meta" text NOT NULL DEFAULT '{}',
        "createdAt" ${dateType} NOT NULL ${createdAtDefault}
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_webhook_delivery_logs_webhookId" ON "webhook_delivery_logs" ("webhookId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_webhook_delivery_logs_idem" ON "webhook_delivery_logs" ("webhookId", "idempotencyKey")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_webhook_delivery_logs_created" ON "webhook_delivery_logs" ("createdAt")`,
    );

    // 3. Nonce table
    await queryRunner.query(`
      CREATE TABLE "webhook_nonces" (
        "id" ${uuidType} PRIMARY KEY NOT NULL${uuidDefault ? ` DEFAULT ${uuidDefault}` : ''},
        "nonce" varchar(255) NOT NULL,
        "createdAt" ${dateType} NOT NULL ${createdAtDefault},
        "expiresAt" ${bigintType} NOT NULL
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_webhook_nonces_nonce" ON "webhook_nonces" ("nonce")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "webhooks" DROP COLUMN "paused"`);
    await queryRunner.query(`ALTER TABLE "webhooks" DROP COLUMN "pausedAt"`);
    await queryRunner.query(`ALTER TABLE "webhooks" DROP COLUMN "pauseReason"`);
    await queryRunner.query(`DROP TABLE "webhook_delivery_logs"`);
    await queryRunner.query(`DROP TABLE "webhook_nonces"`);
  }
}
