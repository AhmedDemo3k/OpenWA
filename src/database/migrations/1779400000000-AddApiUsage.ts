import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the per-day API request counter table backing the dashboard's
 * "API calls today" stat.
 *
 * SQLite installs default to synchronize=true and recreate the schema from the entity, but
 * a DATABASE_SYNCHRONIZE=false SQLite install and Postgres (which never auto-syncs) both
 * need this migration.
 */
export class AddApiUsage1779400000000 implements MigrationInterface {
  name = 'AddApiUsage1779400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';

    if (isPostgres) {
      await queryRunner.query(`
        CREATE TABLE "api_usage" (
          "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
          "date" character varying(10) NOT NULL,
          "requests" integer NOT NULL DEFAULT 0,
          CONSTRAINT "UQ_api_usage_date" UNIQUE ("date")
        )
      `);
    } else {
      await queryRunner.query(`
        CREATE TABLE "api_usage" (
          "id" varchar(36) PRIMARY KEY NOT NULL,
          "date" varchar(10) NOT NULL,
          "requests" integer NOT NULL DEFAULT 0
        )
      `);
      await queryRunner.query(`CREATE UNIQUE INDEX "UQ_api_usage_date" ON "api_usage" ("date")`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';

    if (isPostgres) {
      await queryRunner.query(`DROP TABLE "api_usage"`);
    } else {
      await queryRunner.query(`DROP INDEX "UQ_api_usage_date"`);
      await queryRunner.query(`DROP TABLE "api_usage"`);
    }
  }
}
