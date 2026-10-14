import { FIXTURES } from '@/lib/extraction/fixtures';
import type { DocumentExtractor, ExtractedDocument } from '@/lib/extraction/types';
import type { PrismaClient } from '@/lib/generated/prisma/client';
import { seedDatabase } from '@/prisma/seed-data';
import { createTestDb } from '../helpers/test-db';
import { DRIVER_1, makeService } from './helpers';

const exactExtraction = (FIXTURES.exact as { expected: ExtractedDocument }).expected;

/**
 * Forces the interleaving that a normal run rarely produces: another writer confirms the transaction
 * AFTER our candidates were loaded (txn looks free) but BEFORE our winner is persisted.
 * The partial unique index must reject us, and the pipeline must re-decide instead of failing or double-confirming.
 */
describe('lost auto-confirm race', () => {
  let db: PrismaClient;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ db, cleanup } = await createTestDb()));
  afterAll(() => cleanup());
  beforeEach(() => seedDatabase(db));
  afterEach(() => jest.restoreAllMocks());

  it('re-loads, sees the transaction taken, and ends in review as a possible duplicate with exactly one confirmed match', async () => {
    const extractor: DocumentExtractor = { extract: async () => exactExtraction };
    const { service } = makeService(db, { extractor });
    const [r] = await service.accept({ source: 'WHATSAPP', externalMessageId: 'race', scope: DRIVER_1, attachments: [{ fileName: 'a.jpg', mimeType: 'image/jpeg', bytes: Buffer.from('race') }] });

    // A rival document gets txn_exact confirmed right before our persistence transaction starts.
    const rival = await db.document.create({
      data: { source: 'EMAIL', externalMessageId: 'rival', scopeKey: 'client:client_alnoor', contentHash: 'f'.repeat(64), senderRef: 'ap@alnoor.example', clientId: 'client_alnoor', blobKey: 'f'.repeat(64), mimeType: 'image/jpeg', status: 'MATCHED' },
    });
    const original = db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
    let injected = false;
    jest.spyOn(db, '$transaction').mockImplementation((async (...args: unknown[]) => {
      if (!injected) {
        injected = true;
        await db.documentMatch.create({ data: { documentId: rival.id, transactionId: 'txn_exact', score: 1, rank: 1, signals: {}, status: 'CONFIRMED' } });
      }
      return original(...args);
    }) as never);

    const result = await service.processDocument(r!.documentId);

    expect(injected).toBe(true);
    expect(result).toMatchObject({ status: 'DONE', outcome: 'NEEDS_REVIEW', reason: 'POSSIBLE_DUPLICATE' });
    expect(await db.documentMatch.count({ where: { transactionId: 'txn_exact', status: { in: ['AUTO_CONFIRMED', 'CONFIRMED'] } } })).toBe(1); // the rival's, not ours
    const doc = await db.document.findUniqueOrThrow({ where: { id: r!.documentId }, include: { matches: true } });
    expect(doc).toMatchObject({ status: 'NEEDS_REVIEW', matchReason: 'POSSIBLE_DUPLICATE' });
    // the transaction is now confirmed for the rival, so our copy is offered to a reviewer as an open, flagged candidate
    expect(doc.matches).toHaveLength(1);
    expect(doc.matches[0]).toMatchObject({ transactionId: 'txn_exact', status: 'CANDIDATE' });
    expect((doc.matches[0]!.signals as { flags: string[] }).flags).toEqual(['ALREADY_CONFIRMED']);
  });
});
