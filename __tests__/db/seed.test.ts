import type { PrismaClient } from '@/lib/generated/prisma/client';
import { seedDatabase, seedConfirmedExtraction } from '@/prisma/seed-data';
import { extractedDocumentSchema } from '@/lib/extraction/types';
import { createTestDb } from '../helpers/test-db';
import { SEEDED_TXNS } from '../matcher/fixtures';

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
    const expected = { clients: 2, senders: 3, transactions: 15, documents: 1, matches: 1 };
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
      ['billing@alfanar-fuel.com.sa', 'client_alnoor'], // demo mapping: the assignment's sample email is accepted
    ]);
  });

  it('seeds the assignment\'s own examples: the Alfanar fuel charge and the restaurant charge that carries a tip', async () => {
    await seedDatabase(db);
    expect(await db.transaction.findUniqueOrThrow({ where: { id: 'txn_alfanar' } })).toMatchObject({
      clientId: 'client_alnoor', driverPhone: '+966501111111', merchantName: 'ALFANAR FUEL ST 04 RUH', amountMinor: 28750, externalRef: 'ext_txn_alfanar', cardLast4: null,
    });
    expect((await db.transaction.findUniqueOrThrow({ where: { id: 'txn_alfanar' } })).occurredAt.toISOString()).toBe('2026-10-06T08:05:00.000Z');
    expect(await db.transaction.findUniqueOrThrow({ where: { id: 'txn_restaurant' } })).toMatchObject({
      clientId: 'client_alnoor', driverPhone: '+966502222222', merchantName: 'AL ROMANSIAH RESTAURANT', amountMinor: 6325, cardLast4: null,
    });
  });

  it('spreads the 15 transactions over both clients and every driver phone has at least one', async () => {
    await seedDatabase(db);
    const rows = await db.transaction.findMany();
    expect(new Set(rows.map((t) => t.clientId))).toEqual(new Set(['client_alnoor', 'client_desert']));
    expect(new Set(rows.map((t) => t.driverPhone))).toEqual(new Set(['+966501111111', '+966502222222', '+966503333333']));
    expect(new Set(rows.map((t) => t.externalRef)).size).toBe(15);
  });

  it('the matcher tests\' mirror of the seed (SEEDED_TXNS) cannot drift from the real seed', async () => {
    await seedDatabase(db);
    const rows = await db.transaction.findMany({ orderBy: { id: 'asc' } });
    const confirmed = new Set(['txn_confirmed']);
    expect(
      SEEDED_TXNS.map((t) => ({ id: t.id, clientId: t.clientId, driverPhone: t.driverPhone, merchantName: t.merchantName, amountMinor: t.amountMinor, occurredAt: t.occurredAt, cardLast4: t.cardLast4, alreadyConfirmed: t.alreadyConfirmed })).sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual(rows.map((t) => ({ id: t.id, clientId: t.clientId, driverPhone: t.driverPhone, merchantName: t.merchantName, amountMinor: t.amountMinor, occurredAt: t.occurredAt, cardLast4: t.cardLast4, alreadyConfirmed: confirmed.has(t.id) })));
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
