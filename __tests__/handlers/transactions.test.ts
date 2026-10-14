import { MockExtractor } from '@/lib/extraction/mock-extractor';
import type { PrismaClient } from '@/lib/generated/prisma/client';
import { silentLogger } from '@/lib/logger';
import { createCapturingLogger } from '../logging/capture';
import { rematchForTransactions } from '@/lib/services/rematch';
import { handleTransactionsWebhook } from '@/lib/webhooks/handlers/transactions';
import { seedDatabase } from '@/prisma/seed-data';
import { createTestDb } from '../helpers/test-db';
import { makeService, sendFixture, DRIVER_1, DRIVER_2 } from '../ingestion/helpers';
import { makeDeps, SECRETS, signedRequest } from './helpers';

const URL_ = 'http://localhost/api/webhooks/transactions';
const NOW = new Date('2026-10-06T08:00:00Z');

const txn = (over: Record<string, unknown> = {}) => ({
  externalRef: 'feed-1',
  clientId: 'client_alnoor',
  driverPhone: '0501111111', // local format, must be normalised to E.164
  merchantName: 'ARAMCO RETAIL 0412',
  amountMinor: 18750,
  currency: 'SAR',
  occurredAt: '2026-10-01T09:15:00+03:00',
  ...over,
});

describe('transaction feed + re-match', () => {
  let db: PrismaClient;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ db, cleanup } = await createTestDb()));
  afterAll(() => cleanup());
  beforeEach(() => seedDatabase(db));

  const post = async (payload: unknown, secret = SECRETS.transactions) => {
    const d = makeDeps(db);
    const res = await handleTransactionsWebhook(signedRequest(URL_, payload, secret), d.deps);
    await d.drain();
    return { res, body: (await res.json()) as Record<string, unknown> };
  };

  it('creates transactions, normalises the driver phone, and is idempotent on externalRef', async () => {
    const first = await post([txn()]);
    expect(first.body).toMatchObject({ created: 1, existing: 0 });
    expect(await db.transaction.findUniqueOrThrow({ where: { externalRef: 'feed-1' } })).toMatchObject({ driverPhone: '+966501111111', amountMinor: 18750 });

    const again = await post([txn({ amountMinor: 99999 })]); // redelivery with different data
    expect(again.body).toMatchObject({ created: 0, existing: 1 });
    expect((await db.transaction.findUniqueOrThrow({ where: { externalRef: 'feed-1' } })).amountMinor).toBe(18750); // first write wins
  });

  it('401 for a bad signature, 400 for fractional amounts / unknown client / bad dates', async () => {
    expect((await post([txn()], 'wrong')).res.status).toBe(401);
    expect((await post([txn({ amountMinor: 187.5 })])).res.status).toBe(400); // Prisma would silently TRUNCATE this
    expect((await post([txn({ occurredAt: '2026-10-01' })])).res.status).toBe(400); // no offset => ambiguous instant
    const unknown = await post([txn({ clientId: 'client_nope' })]);
    expect(unknown.res.status).toBe(400);
    expect(JSON.stringify(unknown.body)).toContain('UNKNOWN_CLIENT');
    expect(await db.transaction.count({ where: { externalRef: 'feed-1' } })).toBe(0); // all-or-nothing validation
  });

  it('RE-MATCH: a receipt that arrived BEFORE its transaction is matched when the transaction lands', async () => {
    await db.transaction.delete({ where: { id: 'txn_exact' } }); // card feed has not delivered it yet
    const { service } = makeService(db);
    const { documentId } = await sendFixture(service, 'exact', DRIVER_1);
    expect((await db.document.findUniqueOrThrow({ where: { id: documentId } })).status).toBe('UNMATCHED');

    await post([txn()]);

    const doc = await db.document.findUniqueOrThrow({ where: { id: documentId }, include: { matches: true } });
    expect(doc.status).toBe('MATCHED');
    expect(doc.matches[0]).toMatchObject({ status: 'AUTO_CONFIRMED' });
  });

  it('re-match leaves NEEDS_REVIEW documents alone and never re-offers a pair a reviewer rejected', async () => {
    const { service } = makeService(db);
    const review = await sendFixture(service, 'ambiguous', DRIVER_1); // NEEDS_REVIEW
    await db.transaction.delete({ where: { id: 'txn_exact' } });
    const unmatched = await sendFixture(service, 'exact', DRIVER_1);
    const newTxn = await db.transaction.create({ data: { externalRef: 'late', clientId: 'client_alnoor', driverPhone: '+966501111111', merchantName: 'ARAMCO RETAIL 0412', amountMinor: 18750, occurredAt: new Date('2026-10-01T06:15:00Z') } });
    // a reviewer had already rejected exactly this pair
    await db.documentMatch.create({ data: { documentId: unmatched.documentId, transactionId: newTxn.id, score: 0.9, rank: 1, signals: {}, status: 'REJECTED' } });

    const summary = await rematchForTransactions(db, [newTxn.id], NOW, silentLogger);

    expect(summary).toEqual({ examined: 1, autoMatched: 0, sentToReview: 0 }); // only the UNMATCHED doc was examined, and it stayed unmatched
    expect((await db.document.findUniqueOrThrow({ where: { id: review.documentId } })).status).toBe('NEEDS_REVIEW');
    expect((await db.document.findUniqueOrThrow({ where: { id: unmatched.documentId } })).status).toBe('UNMATCHED');
  });

  it('re-match respects scope: another client\'s new transaction never claims this client\'s receipt', async () => {
    await db.transaction.delete({ where: { id: 'txn_exact' } });
    const { service } = makeService(db);
    const { documentId } = await sendFixture(service, 'exact', DRIVER_2); // driver 2 is not the owner anyway
    const summary = await rematchForTransactions(db, [(await db.transaction.create({ data: { externalRef: 'other', clientId: 'client_desert', driverPhone: '+966503333333', merchantName: 'ARAMCO RETAIL 0412', amountMinor: 18750, occurredAt: new Date('2026-10-01T06:15:00Z') } })).id], NOW, silentLogger);
    expect(summary.examined).toBe(0);
    expect((await db.document.findUniqueOrThrow({ where: { id: documentId } })).status).toBe('UNMATCHED');
  });

  it('a stored extraction in an old shape (pre-rename: amountMinor/confidence) is skipped and logged, and the loop carries on', async () => {
    await db.transaction.delete({ where: { id: 'txn_exact' } });
    const { service } = makeService(db);
    const stale = await sendFixture(service, 'no_transaction', DRIVER_1); // UNMATCHED, received first
    await db.document.update({ where: { id: stale.documentId }, data: { extraction: { documentType: 'TAX_INVOICE', amountMinor: 99999, confidence: 0.96 } } });
    const healthy = await sendFixture(service, 'exact', DRIVER_1); // UNMATCHED, waiting for its transaction
    const late = await db.transaction.create({ data: { externalRef: 'late', clientId: 'client_alnoor', driverPhone: '+966501111111', merchantName: 'ARAMCO RETAIL 0412', amountMinor: 18750, occurredAt: new Date('2026-10-01T06:15:00Z') } });

    const log = createCapturingLogger();
    const summary = await rematchForTransactions(db, [late.id], NOW, log);

    expect(summary).toEqual({ examined: 2, autoMatched: 1, sentToReview: 0 });
    expect((await db.document.findUniqueOrThrow({ where: { id: healthy.documentId } })).status).toBe('MATCHED');
    expect((await db.document.findUniqueOrThrow({ where: { id: stale.documentId } })).status).toBe('UNMATCHED');
    expect(log.entries.find((e) => e.event === 'rematch.extraction_unreadable')?.fields).toMatchObject({ documentId: stale.documentId });
  });

  it('unusable extractions (INSUFFICIENT_DATA) are not re-examined', async () => {
    const { service } = makeService(db, { extractor: new MockExtractor() });
    await sendFixture(service, 'garbage', DRIVER_1);
    const t = await db.transaction.findFirstOrThrow();
    expect((await rematchForTransactions(db, [t.id], NOW, silentLogger)).examined).toBe(0);
  });
});
