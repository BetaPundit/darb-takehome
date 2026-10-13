import type { PrismaClient } from '@/lib/generated/prisma/client';
import { confirmMatchCore, rejectMatchCore, ReviewError, toClientError, type ReviewErrorCode } from '@/lib/actions/review-core';
import type { Logger } from '@/lib/logger';
import { seedDatabase } from '@/prisma/seed-data';
import { createTestDb } from '../helpers/test-db';
import { ALNOOR_EMAIL, DRIVER_1, DRIVER_2, makeService, sendFixture } from '../ingestion/helpers';

let db: PrismaClient;
let cleanup: () => Promise<void>;
beforeAll(async () => ({ db, cleanup } = await createTestDb()));
afterAll(() => cleanup());
beforeEach(() => seedDatabase(db));
afterEach(() => jest.restoreAllMocks());

const rejectsWith = (p: Promise<unknown>, code: ReviewErrorCode) => expect(p).rejects.toMatchObject({ name: 'ReviewError', code });

/** Everything the actions can write, as one comparable value. */
async function snapshot() {
  return {
    documents: await db.document.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true, matchReason: true } }),
    matches: await db.documentMatch.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true, decidedBy: true, decidedAt: true } }),
  };
}

async function matchOf(documentId: string, transactionId: string) {
  return db.documentMatch.findUniqueOrThrow({ where: { documentId_transactionId: { documentId, transactionId } } });
}
const docStatus = async (id: string) => (await db.document.findUniqueOrThrow({ where: { id } })).status;

/** Real pipeline: an ambiguous WhatsApp document with candidates txn_amb_1 and txn_amb_2. */
async function ambiguousDoc() {
  const { service } = makeService(db);
  const { documentId } = await sendFixture(service, 'ambiguous', DRIVER_1);
  expect(await docStatus(documentId)).toBe('NEEDS_REVIEW');
  return documentId;
}

/** Two different documents (WhatsApp driver 2, and the client's email) whose only candidate is txn_tip. */
async function twoTipDocs() {
  const { service } = makeService(db);
  const a = await sendFixture(service, 'tip', DRIVER_2);
  const b = await sendFixture(service, 'tip', ALNOOR_EMAIL);
  expect(await docStatus(a.documentId)).toBe('NEEDS_REVIEW');
  expect(await docStatus(b.documentId)).toBe('NEEDS_REVIEW');
  return { a: a.documentId, b: b.documentId };
}

describe('confirmMatchCore', () => {
  it('confirms the match, rejects sibling candidates and marks the document MATCHED', async () => {
    const docId = await ambiguousDoc();
    const m1 = await matchOf(docId, 'txn_amb_1');
    const m2 = await matchOf(docId, 'txn_amb_2');

    const result = await confirmMatchCore(db, m1.id);

    expect(result).toEqual({ matchId: m1.id, documentId: docId, transactionId: 'txn_amb_1', alreadyConfirmed: false });
    expect(await matchOf(docId, 'txn_amb_1')).toMatchObject({ status: 'CONFIRMED', decidedBy: 'reviewer' });
    expect((await matchOf(docId, 'txn_amb_1')).decidedAt).toBeInstanceOf(Date);
    expect(await matchOf(docId, 'txn_amb_2')).toMatchObject({ id: m2.id, status: 'REJECTED', decidedBy: 'system:sibling-confirmed' });
    expect(await docStatus(docId)).toBe('MATCHED');
  });

  it('double submit: the second confirm reports alreadyConfirmed and changes nothing', async () => {
    const docId = await ambiguousDoc();
    const m1 = await matchOf(docId, 'txn_amb_1');
    await confirmMatchCore(db, m1.id);
    const before = await snapshot();

    const second = await confirmMatchCore(db, m1.id);

    expect(second).toEqual({ matchId: m1.id, documentId: docId, transactionId: 'txn_amb_1', alreadyConfirmed: true });
    expect(await snapshot()).toEqual(before);
  });

  it('confirming an auto-confirmed or seeded confirmed match is also an idempotent no-op', async () => {
    const before = await snapshot();
    await expect(confirmMatchCore(db, 'match_seed_confirmed')).resolves.toMatchObject({ alreadyConfirmed: true });
    expect(await snapshot()).toEqual(before);
  });

  it('a transaction already confirmed for another document is refused with no partial writes', async () => {
    const docId = await ambiguousDoc();
    const rival = await db.document.create({
      data: { source: 'EMAIL', externalMessageId: 'rival', scopeKey: 'client:client_alnoor', contentHash: 'f'.repeat(64), senderRef: 'ap@alnoor.example', clientId: 'client_alnoor', blobKey: 'f'.repeat(64), mimeType: 'image/jpeg', status: 'MATCHED' },
    });
    await db.documentMatch.create({ data: { documentId: rival.id, transactionId: 'txn_amb_1', score: 1, rank: 1, signals: {}, status: 'CONFIRMED' } });
    const m1 = await matchOf(docId, 'txn_amb_1');
    const before = await snapshot();

    await rejectsWith(confirmMatchCore(db, m1.id), 'TRANSACTION_ALREADY_CONFIRMED');

    expect(await snapshot()).toEqual(before);
    expect(await docStatus(docId)).toBe('NEEDS_REVIEW');
    expect(await matchOf(docId, 'txn_amb_2')).toMatchObject({ status: 'CANDIDATE' });
  });

  it('two documents confirmed at once for the same transaction: exactly one wins, the loser gets the typed error', async () => {
    const { a, b } = await twoTipDocs();
    const ma = await matchOf(a, 'txn_tip');
    const mb = await matchOf(b, 'txn_tip');

    const settled = await Promise.allSettled([confirmMatchCore(db, ma.id), confirmMatchCore(db, mb.id)]);

    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ReviewError);
    expect(rejected[0]!.reason).toMatchObject({ code: 'TRANSACTION_ALREADY_CONFIRMED' });
    expect(await db.documentMatch.count({ where: { transactionId: 'txn_tip', status: 'CONFIRMED' } })).toBe(1);
    expect(await db.document.count({ where: { id: { in: [a, b] }, status: 'MATCHED' } })).toBe(1);
  });

  describe('lost race at the unique index', () => {
    /** A competing reviewer confirms txn_tip for another document right before our transaction starts. */
    async function injectCompetitor(documentId: string, hideFromExplicitCheck: boolean) {
      const original = db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
      let injected = false;
      jest.spyOn(db, '$transaction').mockImplementation((async (fn: (tx: PrismaClient) => Promise<unknown>, ...rest: unknown[]) => {
        if (!injected) {
          injected = true;
          await db.documentMatch.update({ where: { documentId_transactionId: { documentId, transactionId: 'txn_tip' } }, data: { status: 'CONFIRMED' } });
        }
        if (!hideFromExplicitCheck) return original(fn, ...rest);
        // Simulate the stale read of a concurrent reader: our pre-check does not see the competitor,
        // so only the partial unique index can stop us.
        return original(async (tx: PrismaClient) => {
          const staleMatch = new Proxy(tx.documentMatch, {
            get: (target, prop, receiver) =>
              prop === 'findFirst' ? async () => null : Reflect.get(target, prop, receiver),
          });
          return fn(new Proxy(tx, { get: (t, p, r) => (p === 'documentMatch' ? staleMatch : Reflect.get(t, p, r)) }));
        }, ...rest);
      }) as never);
      return () => injected;
    }

    it.each([
      ['seen by the pre-check', false],
      ['seen only by the unique index (P2002)', true],
    ])('competitor %s: typed error, no exception, nothing half-written', async (_label, hidden) => {
      const { a, b } = await twoTipDocs();
      const mine = await matchOf(a, 'txn_tip');
      const wasInjected = await injectCompetitor(b, hidden);

      await rejectsWith(confirmMatchCore(db, mine.id), 'TRANSACTION_ALREADY_CONFIRMED');

      expect(wasInjected()).toBe(true);
      expect(await matchOf(a, 'txn_tip')).toMatchObject({ status: 'CANDIDATE', decidedBy: null });
      expect(await docStatus(a)).toBe('NEEDS_REVIEW');
      expect(await db.documentMatch.count({ where: { transactionId: 'txn_tip', status: 'CONFIRMED' } })).toBe(1);
    });
  });

  it('after reject, confirm fails with MATCH_ALREADY_REJECTED', async () => {
    const docId = await ambiguousDoc();
    const m1 = await matchOf(docId, 'txn_amb_1');
    await rejectMatchCore(db, m1.id);
    await rejectsWith(confirmMatchCore(db, m1.id), 'MATCH_ALREADY_REJECTED');
  });

  it('unknown match id => MATCH_NOT_FOUND', async () => {
    await rejectsWith(confirmMatchCore(db, 'nope'), 'MATCH_NOT_FOUND');
  });

  it('confirming for document A rejects document B\'s candidate on the same transaction and leaves B UNMATCHED when nothing else is left', async () => {
    const { a, b } = await twoTipDocs();
    const ma = await matchOf(a, 'txn_tip');

    await confirmMatchCore(db, ma.id);

    expect(await matchOf(b, 'txn_tip')).toMatchObject({ status: 'REJECTED', decidedBy: 'system:txn-taken' });
    const docB = await db.document.findUniqueOrThrow({ where: { id: b } });
    expect(docB.status).toBe('UNMATCHED');
    expect(docB.matchReason).toBe('CANDIDATE_TAKEN');
  });

  it('a document that still has another candidate stays NEEDS_REVIEW when one of its candidates is taken', async () => {
    const docA = await ambiguousDoc();
    const { service } = makeService(db);
    const { documentId: docB } = await sendFixture(service, 'ambiguous', ALNOOR_EMAIL);
    const bMatches = await db.documentMatch.findMany({ where: { documentId: docB, status: 'CANDIDATE' } });
    expect(bMatches.map((m) => m.transactionId)).toEqual(expect.arrayContaining(['txn_amb_1', 'txn_amb_2']));

    await confirmMatchCore(db, (await matchOf(docA, 'txn_amb_1')).id);

    expect(await matchOf(docB, 'txn_amb_1')).toMatchObject({ status: 'REJECTED', decidedBy: 'system:txn-taken' });
    expect(await matchOf(docB, 'txn_amb_2')).toMatchObject({ status: 'CANDIDATE' });
    expect(await docStatus(docB)).toBe('NEEDS_REVIEW');
  });

  describe('scope check (defence in depth)', () => {
    it.each([
      ['WhatsApp document of an Al Noor driver on a Desert Fleet transaction', { source: 'WHATSAPP' as const, senderRef: '+966501111111', clientId: null, scopeKey: 'phone:+966501111111' }],
      ['email document of Al Noor on a Desert Fleet transaction', { source: 'EMAIL' as const, senderRef: 'ap@alnoor.example', clientId: 'client_alnoor', scopeKey: 'client:client_alnoor' }],
    ])('%s => SCOPE_MISMATCH, no writes', async (_label, scope) => {
      const doc = await db.document.create({
        data: { ...scope, externalMessageId: 'x', contentHash: 'e'.repeat(64), blobKey: 'e'.repeat(64), mimeType: 'image/jpeg', status: 'NEEDS_REVIEW' },
      });
      const match = await db.documentMatch.create({ data: { documentId: doc.id, transactionId: 'txn_email', score: 0.6, rank: 1, signals: {}, status: 'CANDIDATE' } });
      const before = await snapshot();

      await rejectsWith(confirmMatchCore(db, match.id), 'SCOPE_MISMATCH');

      expect(await snapshot()).toEqual(before);
    });
  });
});

describe('rejectMatchCore', () => {
  it('rejecting one of several candidates keeps the document in NEEDS_REVIEW', async () => {
    const docId = await ambiguousDoc();
    const m1 = await matchOf(docId, 'txn_amb_1');

    const result = await rejectMatchCore(db, m1.id);

    expect(result).toEqual({ matchId: m1.id, documentStatus: 'NEEDS_REVIEW' });
    expect(await matchOf(docId, 'txn_amb_1')).toMatchObject({ status: 'REJECTED', decidedBy: 'reviewer' });
    expect(await matchOf(docId, 'txn_amb_2')).toMatchObject({ status: 'CANDIDATE' });
  });

  it('rejecting the last candidate makes the document UNMATCHED with a reason', async () => {
    const docId = await ambiguousDoc();
    await rejectMatchCore(db, (await matchOf(docId, 'txn_amb_1')).id);

    const result = await rejectMatchCore(db, (await matchOf(docId, 'txn_amb_2')).id);

    expect(result.documentStatus).toBe('UNMATCHED');
    const doc = await db.document.findUniqueOrThrow({ where: { id: docId } });
    expect(doc).toMatchObject({ status: 'UNMATCHED', matchReason: 'ALL_CANDIDATES_REJECTED' });
  });

  it('rejecting an already rejected match is a no-op success', async () => {
    const docId = await ambiguousDoc();
    const m1 = await matchOf(docId, 'txn_amb_1');
    await rejectMatchCore(db, m1.id);
    const before = await snapshot();

    await expect(rejectMatchCore(db, m1.id)).resolves.toEqual({ matchId: m1.id, documentStatus: 'NEEDS_REVIEW' });

    expect(await snapshot()).toEqual(before);
  });

  it('rejecting a confirmed match is refused (un-confirming is out of scope)', async () => {
    const before = await snapshot();
    await rejectsWith(rejectMatchCore(db, 'match_seed_confirmed'), 'MATCH_ALREADY_CONFIRMED');
    expect(await snapshot()).toEqual(before);
  });

  it('never touches other documents, even ones competing for the same transaction', async () => {
    const { a, b } = await twoTipDocs();
    const mb = await matchOf(b, 'txn_tip');

    await rejectMatchCore(db, (await matchOf(a, 'txn_tip')).id);

    expect(await matchOf(b, 'txn_tip')).toMatchObject({ id: mb.id, status: 'CANDIDATE', decidedBy: null });
    expect(await docStatus(b)).toBe('NEEDS_REVIEW');
  });

  it('unknown match id => MATCH_NOT_FOUND', async () => {
    await rejectsWith(rejectMatchCore(db, 'nope'), 'MATCH_NOT_FOUND');
  });
});

describe('toClientError (handleServerError)', () => {
  const calls: unknown[][] = [];
  const log: Logger = { info() {}, warn() {}, error: (...a) => void calls.push(a) };
  beforeEach(() => void (calls.length = 0));

  it('maps ReviewError to { code, message } and does not log it as a failure', () => {
    const out = toClientError(new ReviewError('TRANSACTION_ALREADY_CONFIRMED'), log);
    expect(out).toEqual({ code: 'TRANSACTION_ALREADY_CONFIRMED', message: 'This transaction was already matched to another document' });
    expect(calls).toHaveLength(0);
  });

  it('turns anything else into a generic message and logs the real error server-side only', () => {
    const out = toClientError(new Error('SQLITE_ERROR: no such table secret_table at /srv/app/dev.db'), log);
    expect(out).toEqual({ code: 'INTERNAL', message: 'Something went wrong. Please try again.' });
    expect(JSON.stringify(out)).not.toMatch(/sqlite|secret|dev\.db/i);
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0])).toMatch(/SQLITE_ERROR/);
  });
});
