import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the sendAt column and the (status, sendAt) lookup index used by the
 * scheduled-message dispatcher.
 *
 * SQLite installs default to synchronize=true and recreate the schema from the entity, but
 * an existing SQLite file created before this column exists still needs the ALTER here when
 * DATABASE_SYNCHRONIZE=false. Postgres never auto-syncs, so it always needs this migration.
 */
export class AddMessageSendAt1779000000000 implements MigrationInterface {
  name = 'AddMessageSendAt1779000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';

    if (isPostgres) {
      await queryRunner.query(`ALTER TABLE "messages" ADD COLUMN "sendAt" timestamp`);
      await queryRunner.query(`CREATE INDEX "IDX_messages_status_sendat" ON "messages" ("status", "sendAt")`);
    } else {
      await queryRunner.query(`ALTER TABLE "messages" ADD COLUMN "sendAt" datetime`);
      await queryRunner.query(`CREATE INDEX "IDX_messages_status_sendat" ON "messages" ("status", "sendAt")`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';

    await queryRunner.query(`DROP INDEX "IDX_messages_status_sendat"`);
    if (isPostgres) {
      await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN "sendAt"`);
    }
    // SQLite cannot drop columns in place; the schema is left as-is on rollback.
  }
}
