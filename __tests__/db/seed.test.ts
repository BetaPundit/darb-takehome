import type { PrismaClient } from '@/lib/generated/prisma/client';
import { seedDatabase, seedConfirmedExtraction } from '@/prisma/seed-data';
import { extractedDocumentSchema } from '@/lib/extraction/types';
import { createTestDb } from '../helpers/test-db';

let db: PrismaClient;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
});
afterAll(() => cleanup());

async function counts() {
  return {
    clients: await db.client.count(),
    senders: await db.clientSender.count(),
    transactions: await db.transaction.count(),
    documents: await db.document.count(),
    matches: await db.documentMatch.count(),
  };
}

describe('seedDatabase', () => {
  it('populates exactly the SCENARIOS.md data and is idempotent', async () => {
    const expected = { clients: 2, senders: 2, transactions: 10, documents: 1, matches: 1 };
    await seedDatabase(db);
    expect(await counts()).toEqual(expected);
    await seedDatabase(db);
    expect(await counts()).toEqual(expected);
  });

  it('seeds the contract values (ids, integer halalas, Riyadh instants stored as UTC)', async () => {
    await seedDatabase(db);
    const exact = await db.transaction.findUniqueOrThrow({ where: { id: 'txn_exact' } });
    expect(exact).toMatchObject({ clientId: 'client_alnoor', driverPhone: '+966501111111', merchantName: 'ARAMCO RETAIL 0412', amountMinor: 18750, externalRef: 'ext_txn_exact', cardLast4: null });
    expect(exact.occurredAt.toISOString()).toBe('2026-10-01T06:15:00.000Z');

    const arabic = await db.transaction.findUniqueOrThrow({ where: { id: 'txn_arabic' } });
    expect(arabic.merchantName).toBe('مطعم البيك');
    expect((await db.transaction.findUniqueOrThrow({ where: { id: 'txn_amb_1' } })).cardLast4).toBe('4242');

    const senders = await db.clientSender.findMany({ orderBy: { email: 'asc' } });
    expect(senders.map((s) => [s.email, s.clientId])).toEqual([
      ['accounts@desertfleet.example', 'client_desert'],
      ['ap@alnoor.example', 'client_alnoor'],
    ]);
  });

  it('seeds doc_seed_confirmed with a schema-valid extraction and a CONFIRMED match to txn_confirmed', async () => {
    await seedDatabase(db);
    const doc = await db.document.findUniqueOrThrow({ where: { id: 'doc_seed_confirmed' }, include: { matches: true } });
    expect(doc).toMatchObject({ source: 'EMAIL', status: 'MATCHED', scopeKey: 'client:client_alnoor', clientId: 'client_alnoor' });
    expect(doc.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(extractedDocumentSchema.parse(doc.extraction)).toEqual(seedConfirmedExtraction);
    expect(doc.matches).toHaveLength(1);
    expect(doc.matches[0]).toMatchObject({ transactionId: 'txn_confirmed', status: 'CONFIRMED' });
  });

  it('wipes data added after a previous seed', async () => {
    await seedDatabase(db);
    await db.client.create({ data: { id: 'extra', name: 'Extra' } });
    await seedDatabase(db);
    expect(await db.client.count()).toBe(2);
  });

  it('refuses to run in production', async () => {
    const env = process.env as Record<string, string | undefined>;
    const prev = env.NODE_ENV;
    env.NODE_ENV = 'production';
    try {
      await expect(seedDatabase(db)).rejects.toThrow(/production/);
    } finally {
      env.NODE_ENV = prev;
    }
  });
});
