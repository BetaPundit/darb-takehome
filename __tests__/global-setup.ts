import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Builds the schema ONCE per jest run by running `prisma migrate deploy` (the same command production
 * uses, so the hand-written partial index is in play) against a template SQLite file. Each DB-backed
 * test file then copies the template (see helpers/test-db.ts).
 */
export default function globalSetup(): void {
  const dir = mkdtempSync(join(tmpdir(), 'darb-jest-'));
  const template = join(dir, 'template.db');

  execFileSync(join(process.cwd(), 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: `file:${template}` },
    stdio: 'pipe',
  });

  // Env set here is inherited by jest workers, which are spawned after globalSetup.
  process.env.DARB_TEST_DB_DIR = dir;
  process.env.DARB_TEST_DB_TEMPLATE = template;
}
