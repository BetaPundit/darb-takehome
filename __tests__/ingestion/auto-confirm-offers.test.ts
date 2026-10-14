import { FIXTURES } from '@/lib/extraction/fixtures';
import type { DocumentExtractor, ExtractedDocument } from '@/lib/extraction/types';
import type { PrismaClient } from '@/lib/generated/prisma/client';
import { seedDatabase } from '@/prisma/seed-data';
import { createTestDb } from '../helpers/test-db';
import { DRIVER_1, DRIVER_2, makeService, sendFixture } from './helpers';

/**
 * Found by the end-to-end run: when one document AUTO-confirms a transaction, other documents that were
 * previously OFFERED that transaction must have the offer withdrawn, exactly as when a reviewer confirms.
 * Otherwise the review queue shows candidates that can only fail with "already matched".
 */
describe('auto-confirm withdraws competing offers', () => {
  let db: PrismaClient;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ db, cleanup } = await createTestDb()));
  afterAll(() => cleanup());
  beforeEach(() => seedDatabase(db));

  const offers = (documentId: string) =>
    db.documentMatch.findMany({ where: { documentId }, orderBy: { transactionId: 'asc' }, select: { transactionId: true, status: true, decidedBy: true } });

  it('ambiguous document keeps its OTHER candidate and loses the taken one', async () => {
    const { service } = makeService(db);
    const review = await sendFixture(service, 'ambiguous', DRIVER_1); // offered txn_amb_1 and txn_amb_2
    await sendFixture(service, 'ambiguous_last4', DRIVER_1); // auto-confirms txn_amb_1

    expect(await offers(review.documentId)).toEqual([
      { transactionId: 'txn_amb_1', status: 'REJECTED', decidedBy: 'system:txn-taken' },
      { transactionId: 'txn_amb_2', status: 'CANDIDATE', decidedBy: null },
    ]);
    expect((await db.document.findUniqueOrThrow({ where: { id: review.documentId } })).status).toBe('NEEDS_REVIEW');
  });

  it('a document whose ONLY offer was taken goes back to UNMATCHED instead of sitting in review with nothing to review', async () => {
    const { service: mock } = makeService(db);
    const first = await sendFixture(mock, 'low_confidence', DRIVER_2); // NEEDS_REVIEW, sole candidate txn_lowconf
    expect((await db.document.findUniqueOrThrow({ where: { id: first.documentId } })).status).toBe('NEEDS_REVIEW');

    // a second document for the same transaction that DOES clear the confidence bar
    const confident = { ...(FIXTURES.low_confidence as { expected: ExtractedDocument }).expected, extractionConfidence: 0.95 };
    const extractor: DocumentExtractor = { extract: async () => confident };
    const { service: stub } = makeService(db, { extractor });
    const [r] = await stub.accept({ source: 'WHATSAPP', externalMessageId: 'second', scope: DRIVER_2, attachments: [{ fileName: 'b.jpg', mimeType: 'image/jpeg', bytes: Buffer.from('second doc') }] });
    expect(await stub.processDocument(r!.documentId)).toMatchObject({ status: 'DONE', outcome: 'AUTO_MATCHED' });

    const loser = await db.document.findUniqueOrThrow({ where: { id: first.documentId } });
    expect(loser).toMatchObject({ status: 'UNMATCHED', matchReason: 'CANDIDATE_TAKEN' });
    expect(await offers(first.documentId)).toEqual([{ transactionId: 'txn_lowconf', status: 'REJECTED', decidedBy: 'system:txn-taken' }]);
  });

  it('documents that are not waiting on a review are left alone', async () => {
    const { service } = makeService(db);
    const matched = await sendFixture(service, 'exact', DRIVER_1); // MATCHED, alternatives stored REJECTED
    const before = await offers(matched.documentId);
    await sendFixture(service, 'prevat', DRIVER_1); // unrelated auto-confirm
    expect(await offers(matched.documentId)).toEqual(before);
    expect((await db.document.findUniqueOrThrow({ where: { id: matched.documentId } })).status).toBe('MATCHED');
  });
});
