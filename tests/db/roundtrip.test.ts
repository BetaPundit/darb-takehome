import { DocumentStatus, MatchStatus, Source } from '@/lib/generated/prisma/client';
import type { PrismaClient } from '@/lib/generated/prisma/client';
import { seedDatabase } from '@/prisma/seed-data';
import { createTestDb } from '../helpers/test-db';

let db: PrismaClient;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await seedDatabase(db);
});
afterAll(() => cleanup());

describe('money', () => {
  it('round-trips amountMinor as an integer and stores it as SQLite INTEGER, never REAL', async () => {
    const t = await db.transaction.create({
      data: { clientId: 'client_alnoor', externalRef: 'ext_big', merchantName: 'M', amountMinor: 2147483647, occurredAt: new Date('2026-10-01T00:00:00Z') },
    });
    const read = await db.transaction.findUniqueOrThrow({ where: { id: t.id } });
    expect(read.amountMinor).toBe(2147483647);
    expect(Number.isInteger(read.amountMinor)).toBe(true);

    const rows = await db.$queryRaw<{ type: string }[]>`SELECT typeof("amountMinor") AS type FROM "Transaction"`;
    expect(new Set(rows.map((r) => r.type))).toEqual(new Set(['integer']));
  });

  it('characterization: Prisma silently truncates a fractional Int, so fractional amounts must be rejected by Zod upstream', async () => {
    const t = await db.transaction.create({
      data: { clientId: 'client_alnoor', externalRef: 'ext_frac', merchantName: 'M', amountMinor: 18750.5, occurredAt: new Date('2026-10-01T00:00:00Z') },
    });
    expect(t.amountMinor).toBe(18750);
  });
});

describe('enums', () => {
  it('exposes exactly the assignment enum names', () => {
    expect(Object.values(Source).sort()).toEqual(['EMAIL', 'WHATSAPP']);
    expect(Object.values(DocumentStatus).sort()).toEqual(['EXTRACTED', 'FAILED', 'MATCHED', 'NEEDS_REVIEW', 'RECEIVED', 'UNMATCHED']);
    expect(Object.values(MatchStatus).sort()).toEqual(['AUTO_CONFIRMED', 'CANDIDATE', 'CONFIRMED', 'REJECTED']);
  });

  it('round-trips every value, stored as the bare name (the partial index relies on this)', async () => {
    const statuses = Object.values(DocumentStatus);
    for (const [i, status] of statuses.entries()) {
      await db.document.create({
        data: { source: i % 2 ? 'WHATSAPP' : 'EMAIL', externalMessageId: `enum-${i}`, scopeKey: `s${i}`, contentHash: `h${i}`, senderRef: 'x', blobKey: 'b', mimeType: 'image/png', status },
      });
    }
    const docs = await db.document.findMany({ where: { externalMessageId: { startsWith: 'enum-' } }, orderBy: { externalMessageId: 'asc' } });
    expect(docs.map((d) => d.status)).toEqual(statuses);
    expect(docs.map((d) => d.source)).toEqual(statuses.map((_, i) => (i % 2 ? 'WHATSAPP' : 'EMAIL')));

    const raw = await db.$queryRaw<{ status: string }[]>`SELECT "status" FROM "Document" WHERE "externalMessageId" LIKE 'enum-%' ORDER BY "externalMessageId"`;
    expect(raw.map((r) => r.status)).toEqual(statuses);

    const matchRaw = await db.$queryRaw<{ status: string }[]>`SELECT "status" FROM "DocumentMatch" WHERE id = 'match_seed_confirmed'`;
    expect(matchRaw[0]?.status).toBe('CONFIRMED');
  });
});
