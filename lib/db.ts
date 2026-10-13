import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@/lib/generated/prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export function createPrismaClient(url: string = process.env.DATABASE_URL ?? 'file:./dev.db') {
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
}

// Reused across Next.js dev hot reloads so we don't leak SQLite handles.
export const db = globalForPrisma.prisma ?? createPrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;
