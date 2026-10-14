import { FIXTURES } from '@/lib/extraction/fixtures';
import type { DocumentExtractor, ExtractedDocument } from '@/lib/extraction/types';
import type { PrismaClient } from '@/lib/generated/prisma/client';
import { seedDatabase } from '@/prisma/seed-data';
import { createTestDb } from '../helpers/test-db';
import { DRIVER_1, makeService, nextMessageId } from './helpers';

const exact = (FIXTURES.exact as { expected: ExtractedDocument }).expected; // Aramco 187.50 SAR, charged 2026-10-01 09:15 Riyadh (txn_exact)

describe('ISO 8601 documentDate through the real pipeline (candidate window + date signal, Riyadh calendar days)', () => {
  let db: PrismaClient;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ db, cleanup } = await createTestDb()));
  afterAll(() => cleanup());
  beforeEach(() => seedDatabase(db));

  async function run(documentDate: string | null) {
    const extractor: DocumentExtractor = { extract: async () => ({ ...exact, documentDate }) };
    const { service } = makeService(db, { extractor });
    const [r] = await service.accept({ source: 'WHATSAPP', externalMessageId: nextMessageId(), scope: DRIVER_1, attachments: [{ fileName: 'x.jpg', mimeType: 'image/jpeg', bytes: Buffer.from(nextMessageId()) }] });
    const result = await service.processDocument(r!.documentId);
    const doc = await db.document.findUniqueOrThrow({ where: { id: r!.documentId }, include: { matches: true } });
    return { result, doc };
  }

  it.each([
    ['a date', '2026-10-01'],
    ['an offset datetime on the charge day', '2026-10-01T09:15:00+03:00'],
    ['a Z datetime that is the same Riyadh day', '2026-10-01T06:15:00Z'],
    ['a western-offset datetime that is the same Riyadh day', '2026-10-01T00:15:00-06:00'],
  ])('%s: same day as the charge => AUTO_MATCHED', async (_name, date) => {
    const { result, doc } = await run(date);
    expect(result).toMatchObject({ status: 'DONE', outcome: 'AUTO_MATCHED' });
    expect(doc.matches[0]).toMatchObject({ transactionId: 'txn_exact', status: 'AUTO_CONFIRMED' });
  });

  it('a Z datetime late in the evening UTC is the NEXT day in Riyadh: one day after the charge, so the date signal drops and it goes to review', async () => {
    const { result, doc } = await run('2026-10-01T22:30:00Z'); // Oct 2, 01:30 in Riyadh
    expect(result).toMatchObject({ status: 'DONE', outcome: 'NEEDS_REVIEW', reason: 'BELOW_AUTO_THRESHOLD' });
    expect(doc.matches[0]).toMatchObject({ transactionId: 'txn_exact', status: 'CANDIDATE', signals: { date: 0.7, flags: ['DATE_OFFSET'] } });
  });
});
