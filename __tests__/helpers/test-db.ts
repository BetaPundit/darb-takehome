import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPrismaClient } from '@/lib/prisma-client';
import type { PrismaClient } from '@/lib/generated/prisma/client';

/**
 * An isolated, migrated SQLite database for one test file. The schema comes from the template built once in
 * __tests__/global-setup.ts, so this is a file copy (milliseconds), safe across parallel jest workers.
 * Call `cleanup()` in afterAll.
 */
export async function createTestDb(): Promise<{ db: PrismaClient; cleanup: () => Promise<void> }> {
  const dir = process.env.DARB_TEST_DB_DIR;
  const template = process.env.DARB_TEST_DB_TEMPLATE;
  if (!dir || !template) throw new Error('Test DB template missing: jest globalSetup (__tests__/global-setup.ts) did not run.');

  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${randomUUID()}.db`);
  copyFileSync(template, file);

  const db = createPrismaClient(`file:${file}`);
  return {
    db,
    cleanup: async () => {
      await db.$disconnect();
      for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(file + suffix, { force: true });
    },
  };
}
