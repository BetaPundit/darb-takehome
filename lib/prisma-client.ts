import { PrismaClient } from '@/lib/generated/prisma/client';

/**
 * Side-effect free: tests and scripts build their own client on their own DB file.
 *
 * - Prisma 6 resolves a RELATIVE sqlite url against the schema directory (prisma/), not the cwd,
 *   hence the default `file:../dev.db` = ./dev.db at the project root. Absolute paths are unaffected.
 * - `connection_limit=1`: SQLite allows one writer. With Prisma's default pool, concurrent interactive
 *   transactions (read, then write) each hold their own connection and fail to upgrade to a write lock
 *   with SQLITE_BUSY; measured: 200 parallel transactions took 94s and 192 of them failed (P2028/P1008).
 *   One connection queues them instead (same 200 in ~0.1s, 0 failures), like the driver adapter did.
 */
export function createPrismaClient(url: string = process.env.DATABASE_URL ?? 'file:../dev.db') {
  const withLimit = url.includes('connection_limit=') ? url : `${url}${url.includes('?') ? '&' : '?'}connection_limit=1`;
  return new PrismaClient({ datasourceUrl: withLimit });
}
