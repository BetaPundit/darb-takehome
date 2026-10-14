import type { PrismaClient } from '@/lib/generated/prisma/client';
import { createTestDb } from '../helpers/test-db';

let db: PrismaClient;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await db.client.create({ data: { id: 'c1', name: 'Client' } });
});
afterAll(() => cleanup());

describe('SQLite connection handling', () => {
  // With Prisma's default connection pool, parallel read-then-write interactive transactions fail with
  // SQLITE_BUSY / socket timeouts (see lib/prisma-client.ts). A single queued connection must serve them all.
  it('serves many parallel read-then-write transactions without lock errors', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, (_, i) =>
        db.$transaction(async (tx) => {
          await tx.client.count();
          await tx.transaction.create({
            data: { clientId: 'c1', externalRef: `ref-${i}`, merchantName: 'M', amountMinor: 1, occurredAt: new Date() },
          });
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(await db.transaction.count()).toBe(40);
  });
});
