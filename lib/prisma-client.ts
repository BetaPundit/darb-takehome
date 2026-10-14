import path from 'node:path';
import { PrismaClient } from '@/lib/generated/prisma/client';

/**
 * Make a sqlite `file:` url absolute, the way the Prisma CLI reads it: relative to the prisma/ folder
 * (so `file:../dev.db` is ./dev.db at the project root).
 *
 * Why we do it ourselves: the generated client resolves a relative path as `<dirname of the generated client> + <relative
 * path to prisma/>`. In plain Node that is the real prisma/ folder, but inside Next's bundled server the "dirname" is a
 * build-chunk folder under .next/, so the same url pointed at a file that does not exist ("Error code 14: Unable to open
 * the database file") while the CLI, scripts and tests all worked. An absolute path is the same everywhere.
 */
export function resolveDatabaseUrl(url: string, baseDir: string = path.resolve(process.cwd(), 'prisma')): string {
  const match = /^file:([^?]*)(\?.*)?$/.exec(url);
  if (!match) return url;
  const [, filePath = '', query = ''] = match;
  return `file:${path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath)}${query}`;
}

/**
 * Side-effect free: tests and scripts build their own client on their own DB file.
 *
 * - `connection_limit=1`: SQLite allows one writer. With Prisma's default pool, concurrent interactive
 *   transactions (read, then write) each hold their own connection and fail to upgrade to a write lock
 *   with SQLITE_BUSY; measured: 200 parallel transactions took 94s and 192 of them failed (P2028/P1008).
 *   One connection queues them instead (same 200 in ~0.1s, 0 failures).
 */
export function createPrismaClient(url: string = process.env.DATABASE_URL ?? 'file:../dev.db') {
  const resolved = resolveDatabaseUrl(url);
  const withLimit = resolved.includes('connection_limit=') ? resolved : `${resolved}${resolved.includes('?') ? '&' : '?'}connection_limit=1`;
  return new PrismaClient({ datasourceUrl: withLimit });
}
