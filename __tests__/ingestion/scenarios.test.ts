import type { FixtureName } from '@/lib/extraction/fixtures';
import type { PrismaClient } from '@/lib/generated/prisma/client';
import { seedDatabase } from '@/prisma/seed-data';
import { createTestDb } from '../helpers/test-db';
import { ALFANAR_EMAIL, ALNOOR_EMAIL, DESERT_DRIVER, DESERT_EMAIL, DRIVER_1, DRIVER_2, makeService, sendFixture } from './helpers';

/**
 * End-to-end through the real pipeline (accept -> extract -> match -> persist) against the seeded DB.
 * Each row is one line of the shared scenario contract.
 */
type Row = [FixtureName, Parameters<typeof sendFixture>[2], string, string, string[]];
//          fixture,          sender,                          doc status,  reason,                    [matches: "txnId:STATUS"]
const rows: Row[] = [
  ['exact', DRIVER_1, 'MATCHED', 'CLEAR_WINNER', ['txn_exact:AUTO_CONFIRMED']],
  ['ambiguous', DRIVER_1, 'NEEDS_REVIEW', 'AMBIGUOUS', ['txn_amb_1:CANDIDATE', 'txn_amb_2:CANDIDATE']],
  ['ambiguous_last4', DRIVER_1, 'MATCHED', 'CLEAR_WINNER', ['txn_amb_1:AUTO_CONFIRMED']],
  ['tip', DRIVER_2, 'NEEDS_REVIEW', 'BELOW_AUTO_THRESHOLD', ['txn_tip:CANDIDATE']],
  ['rounding', DRIVER_2, 'MATCHED', 'CLEAR_WINNER', ['txn_round:AUTO_CONFIRMED']],
  ['prevat', DRIVER_1, 'MATCHED', 'CLEAR_WINNER', ['txn_prevat:AUTO_CONFIRMED']],
  ['no_transaction', DRIVER_1, 'UNMATCHED', 'NO_PLAUSIBLE_CANDIDATE', []],
  ['garbage', DRIVER_1, 'UNMATCHED', 'INSUFFICIENT_DATA', []],
  ['low_confidence', DRIVER_2, 'NEEDS_REVIEW', 'LOW_EXTRACTION_CONFIDENCE', ['txn_lowconf:CANDIDATE']],
  ['email_exact', DESERT_EMAIL, 'MATCHED', 'CLEAR_WINNER', ['txn_email:AUTO_CONFIRMED']],
  ['arabic', DESERT_DRIVER, 'MATCHED', 'CLEAR_WINNER', ['txn_arabic:AUTO_CONFIRMED']],
  // txn_confirmed already has a confirmed document: the receipt is a possible duplicate, so it is offered for review (never auto, never dropped)
  ['already_confirmed', DRIVER_1, 'NEEDS_REVIEW', 'POSSIBLE_DUPLICATE', ['txn_confirmed:CANDIDATE']],
  // the assignment's own examples: a tax invoice by email, and a restaurant receipt whose charge carries a tip
  ['alfanar_invoice', ALFANAR_EMAIL, 'MATCHED', 'CLEAR_WINNER', ['txn_alfanar:AUTO_CONFIRMED']],
  ['restaurant_tip', DRIVER_2, 'NEEDS_REVIEW', 'BELOW_AUTO_THRESHOLD', ['txn_restaurant:CANDIDATE']],
];

describe('scenario table through the real pipeline', () => {
  let db: PrismaClient;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ db, cleanup } = await createTestDb()));
  afterAll(() => cleanup());
  beforeEach(() => seedDatabase(db));

  it.each(rows)('%s', async (fixture, sender, status, reason, expectedMatches) => {
    const { service } = makeService(db);
    const { documentId } = await sendFixture(service, fixture, sender);

    const doc = await db.document.findUniqueOrThrow({ where: { id: documentId }, include: { matches: { orderBy: { rank: 'asc' } } } });
    expect(doc.status).toBe(status);
    expect(doc.matchReason).toBe(reason);
    // For an auto-match, alternatives are kept as REJECTED for audit; assert only the confirmed/candidate rows.
    const live = doc.matches.filter((m) => m.status !== 'REJECTED').map((m) => `${m.transactionId}:${m.status}`);
    expect(live.sort()).toEqual([...expectedMatches].sort());
  });

  it('forced extractor failure ends FAILED with the code, not an error', async () => {
    const { service } = makeService(db);
    const { documentId, result } = await sendFixture(service, 'forced_failure', DRIVER_1);
    expect(result).toEqual({ status: 'FAILED', reason: 'FIXTURE_FORCED_FAILURE' });
    const doc = await db.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(doc).toMatchObject({ status: 'FAILED', failureReason: 'FIXTURE_FORCED_FAILURE' });
  });

  it('records the ranked signal breakdown for review', async () => {
    const { service } = makeService(db);
    const { documentId } = await sendFixture(service, 'ambiguous', DRIVER_1);
    const matches = await db.documentMatch.findMany({ where: { documentId }, orderBy: { rank: 'asc' } });
    expect(matches).toHaveLength(2);
    expect(matches[0]!.signals).toMatchObject({ amount: 1, merchant: 1, date: 1, card: null, flags: [] });
    expect(matches[0]!.score).toBe(matches[1]!.score); // a true tie
  });

  it('restaurant_tip: 57.50 vs 63.25 is offered to a reviewer with the tip flag, not auto-matched', async () => {
    const { service } = makeService(db);
    const { documentId } = await sendFixture(service, 'restaurant_tip', DRIVER_2);
    const [m] = await db.documentMatch.findMany({ where: { documentId } });
    expect(m).toMatchObject({ transactionId: 'txn_restaurant', status: 'CANDIDATE', rank: 1 });
    expect(m!.signals).toMatchObject({ amount: 0.625, merchant: 1, date: 1, flags: ['TIP_SUSPECTED'] });
    expect(m!.score).toBeCloseTo(0.73125, 3);
  });

  describe('possible duplicates: a transaction that already has a confirmed document', () => {
    const confirmedRows = (transactionId: string) =>
      db.documentMatch.findMany({ where: { transactionId, status: { in: ['AUTO_CONFIRMED', 'CONFIRMED'] } } });

    it('already_confirmed: the candidate is stored as a normal CANDIDATE row carrying the ALREADY_CONFIRMED flag; the seeded confirmation is untouched', async () => {
      const { service } = makeService(db);
      const { documentId } = await sendFixture(service, 'already_confirmed', DRIVER_1);

      const [m] = await db.documentMatch.findMany({ where: { documentId } });
      expect(m).toMatchObject({ transactionId: 'txn_confirmed', status: 'CANDIDATE', rank: 1, decidedBy: null });
      expect(m!.signals).toMatchObject({ amount: 1, merchant: 1, date: 1, flags: ['ALREADY_CONFIRMED'] });
      expect(m!.score).toBe(0.9); // scored normally
      // two rows for one transaction is fine: the partial unique index only covers confirmed statuses
      expect((await confirmedRows('txn_confirmed')).map((r) => r.id)).toEqual(['match_seed_confirmed']);
      expect(await db.documentMatch.count({ where: { transactionId: 'txn_confirmed' } })).toBe(2);
    });

    it('cross-channel duplicate: the same receipt by WhatsApp, then by email => the second is NEEDS_REVIEW / POSSIBLE_DUPLICATE for the same transaction', async () => {
      const { service } = makeService(db);
      const first = await sendFixture(service, 'exact', DRIVER_1);
      expect((await db.document.findUniqueOrThrow({ where: { id: first.documentId } })).status).toBe('MATCHED');

      const second = await sendFixture(service, 'exact', ALNOOR_EMAIL); // other scope, so not a content-hash duplicate
      const doc = await db.document.findUniqueOrThrow({ where: { id: second.documentId }, include: { matches: true } });
      expect(doc).toMatchObject({ status: 'NEEDS_REVIEW', matchReason: 'POSSIBLE_DUPLICATE' });
      expect(doc.matches.map((m) => `${m.transactionId}:${m.status}`)).toEqual(['txn_exact:CANDIDATE']);
      // and exactly one document holds the confirmation
      expect((await confirmedRows('txn_exact')).map((r) => r.documentId)).toEqual([first.documentId]);
      expect((await db.document.findUniqueOrThrow({ where: { id: first.documentId } })).status).toBe('MATCHED');
    });

    it('an open twin stays the first choice: a copy of receipt 1 plus an identical open purchase => review, open one ranked first, duplicate flagged', async () => {
      const { service } = makeService(db);
      await sendFixture(service, 'ambiguous_last4', DRIVER_1); // auto-confirms txn_amb_1 (card 4242)
      const { documentId } = await sendFixture(service, 'ambiguous', DRIVER_1); // same amount/merchant/day, no card

      const doc = await db.document.findUniqueOrThrow({ where: { id: documentId }, include: { matches: { orderBy: { rank: 'asc' } } } });
      expect(doc).toMatchObject({ status: 'NEEDS_REVIEW', matchReason: 'AMBIGUOUS' });
      expect(doc.matches.map((m) => `${m.rank}:${m.transactionId}:${m.status}`)).toEqual(['1:txn_amb_2:CANDIDATE', '2:txn_amb_1:CANDIDATE']);
      expect((doc.matches[1]!.signals as { flags: string[] }).flags).toEqual(['ALREADY_CONFIRMED']);
      expect((doc.matches[0]!.signals as { flags: string[] }).flags).toEqual([]);
    });
  });

  it('SCOPE: a client cannot match another client\'s transaction, even with a perfect document', async () => {
    const { service } = makeService(db);
    // email_exact matches txn_email, which belongs to client_desert. Send it as client_alnoor.
    const { documentId } = await sendFixture(service, 'email_exact', ALNOOR_EMAIL);
    const doc = await db.document.findUniqueOrThrow({ where: { id: documentId }, include: { matches: true } });
    expect(doc.status).not.toBe('MATCHED');
    expect(doc.matches.map((m) => m.transactionId)).not.toContain('txn_email');
    // Not UNMATCHED any more, by coincidence of the seed: 250.00 + 15% VAT is exactly txn_alfanar's 287.50 (alnoor's own),
    // a weak reviewable candidate. The invariant under test is the scope, not the emptiness.
    expect(doc.matches.map((m) => `${m.transactionId}:${m.status}`)).toEqual(['txn_alfanar:CANDIDATE']);
  });

  it('SCOPE: a driver cannot match another driver\'s transaction', async () => {
    const { service } = makeService(db);
    // 'exact' belongs to DRIVER_1's txn_exact. DRIVER_2 sends it.
    const { documentId } = await sendFixture(service, 'exact', DRIVER_2);
    const doc = await db.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(doc.status).toBe('UNMATCHED');
  });
});
