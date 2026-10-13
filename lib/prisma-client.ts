import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@/lib/generated/prisma/client';

/** Side-effect free: tests and scripts build their own client on their own DB file. */
export function createPrismaClient(url: string = process.env.DATABASE_URL ?? 'file:./dev.db') {
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
}
