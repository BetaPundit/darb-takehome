import type { PrismaClient } from '@/lib/generated/prisma/client';
import { createPrismaClient } from '@/lib/prisma-client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Reused across Next.js dev hot reloads so we don't leak SQLite handles.
export const db = globalForPrisma.prisma ?? createPrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;

/** The singleton, as the default export (`import prisma from '@/lib/prisma'`). The named `db` export is the same object. */
export default db;
