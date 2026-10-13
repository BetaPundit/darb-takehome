import Database from 'better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Builds the schema ONCE per jest run by replaying prisma/migrations/*\/migration.sql (in name order)
 * into a template SQLite file. Each DB-backed test file then copies the template (see helpers/test-db.ts).
 * Replaying the same SQL files that `prisma migrate deploy` applies keeps the hand-written partial index in play.
 */
export default function globalSetup(): void {
  const dir = mkdtempSync(join(tmpdir(), 'darb-jest-'));
  const template = join(dir, 'template.db');
  const migrationsDir = join(process.cwd(), 'prisma', 'migrations');

  const conn = new Database(template);
  try {
    for (const name of readdirSync(migrationsDir).sort()) {
      const sqlFile = join(migrationsDir, name, 'migration.sql');
      if (existsSync(sqlFile)) conn.exec(readFileSync(sqlFile, 'utf8'));
    }
  } finally {
    conn.close();
  }

  // Env set here is inherited by jest workers, which are spawned after globalSetup.
  process.env.DARB_TEST_DB_DIR = dir;
  process.env.DARB_TEST_DB_TEMPLATE = template;
}
