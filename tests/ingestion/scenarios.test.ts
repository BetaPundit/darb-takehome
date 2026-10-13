import type { FixtureName } from '@/lib/extraction/fixtures';
import type { PrismaClient } from '@/lib/generated/prisma/client';
import { seedDatabase } from '@/prisma/seed-data';
import { createTestDb } from '../helpers/test-db';
import { ALNOOR_EMAIL, DESERT_DRIVER, DESERT_EMAIL, DRIVER_1, DRIVER_2, makeService, sendFixture } from './helpers';

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
  ['already_confirmed', DRIVER_1, 'UNMATCHED', 'NO_PLAUSIBLE_CANDIDATE', []],
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

  it('SCOPE: a client cannot match another client\'s transaction, even with a perfect document', async () => {
    const { service } = makeService(db);
    // email_exact matches txn_email, which belongs to client_desert. Send it as client_alnoor.
    const { documentId } = await sendFixture(service, 'email_exact', ALNOOR_EMAIL);
    const doc = await db.document.findUniqueOrThrow({ where: { id: documentId }, include: { matches: true } });
    expect(doc.status).toBe('UNMATCHED');
    expect(doc.matches).toHaveLength(0);
  });

  it('SCOPE: a driver cannot match another driver\'s transaction', async () => {
    const { service } = makeService(db);
    // 'exact' belongs to DRIVER_1's txn_exact. DRIVER_2 sends it.
    const { documentId } = await sendFixture(service, 'exact', DRIVER_2);
    const doc = await db.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(doc.status).toBe('UNMATCHED');
  });
});
