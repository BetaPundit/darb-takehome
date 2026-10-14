import { fixtureBytes, fixtureExpected } from '@/lib/extraction/fixtures';
import type { DocumentExtractor } from '@/lib/extraction/types';
import type { PrismaClient } from '@/lib/generated/prisma/client';
import { silentLogger } from '@/lib/logger';
import { InMemoryBlobStore } from '@/lib/services/blob-store';
import { createIngestionService } from '@/lib/services/document-ingestion';
import { handleEmailWebhook } from '@/lib/webhooks/handlers/email';
import { handleWhatsAppWebhook } from '@/lib/webhooks/handlers/whatsapp';
import { seedDatabase } from '@/prisma/seed-data';
import { createTestDb } from '../helpers/test-db';
import { emailPayload, makeDeps, mediaIdFor, SECRETS, signedRequest, waPayload } from './helpers';

const EMAIL_URL = 'http://localhost/api/webhooks/email';
const WA_URL = 'http://localhost/api/webhooks/whatsapp';

/** Possible duplicates through the real handlers: the second document for an already-confirmed transaction goes to review. */
describe('possible duplicate receipts through the webhooks', () => {
  let db: PrismaClient;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ db, cleanup } = await createTestDb()));
  afterAll(() => cleanup());
  beforeEach(() => seedDatabase(db));

  async function whatsapp(id: string, fixture: Parameters<typeof mediaIdFor>[0], from = '966501111111') {
    const { deps, drain } = makeDeps(db);
    const res = await handleWhatsAppWebhook(signedRequest(WA_URL, waPayload([{ id, from, media: mediaIdFor(fixture) }]), SECRETS.whatsapp, 'x-hub-signature-256'), deps);
    await drain();
    return { res, body: (await res.json()) as Record<string, unknown> };
  }
  async function email(id: string, fixtures: Parameters<typeof emailPayload>[1], from = 'ap@alnoor.example') {
    const { deps, drain } = makeDeps(db);
    const res = await handleEmailWebhook(signedRequest(EMAIL_URL, emailPayload(id, fixtures, from), SECRETS.email), deps);
    await drain();
    return { res, body: (await res.json()) as Record<string, unknown> };
  }
  const docOf = (externalMessageId: string) => db.document.findFirstOrThrow({ where: { externalMessageId }, include: { matches: true } });

  it('the already_confirmed fixture from the driver of txn_confirmed: 200, NEEDS_REVIEW / POSSIBLE_DUPLICATE with the flagged candidate', async () => {
    const { res, body } = await whatsapp('wamid.dup1', 'already_confirmed');
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: 'accepted', documents: 1 });
    const doc = await docOf('wamid.dup1');
    expect(doc).toMatchObject({ status: 'NEEDS_REVIEW', matchReason: 'POSSIBLE_DUPLICATE' });
    expect(doc.matches).toHaveLength(1);
    expect(doc.matches[0]).toMatchObject({ transactionId: 'txn_confirmed', status: 'CANDIDATE' });
    expect((doc.matches[0]!.signals as { flags: string[] }).flags).toEqual(['ALREADY_CONFIRMED']);
  });

  it('the same receipt by WhatsApp and then by email (cross-channel): the second lands in review for the same transaction', async () => {
    await whatsapp('wamid.x1', 'exact');
    expect((await docOf('wamid.x1')).status).toBe('MATCHED');

    const { res } = await email('<x2@alnoor>', ['exact']);
    expect(res.status).toBe(200);
    const second = await docOf('<x2@alnoor>');
    expect(second).toMatchObject({ source: 'EMAIL', status: 'NEEDS_REVIEW', matchReason: 'POSSIBLE_DUPLICATE' });
    expect(second.matches.map((m) => `${m.transactionId}:${m.status}`)).toEqual(['txn_exact:CANDIDATE']);
    expect(await db.documentMatch.count({ where: { transactionId: 'txn_exact', status: { in: ['AUTO_CONFIRMED', 'CONFIRMED'] } } })).toBe(1);
  });

  describe('flooding: what a sender can and cannot do with the rule', () => {
    it('re-sending the SAME bytes (same sender) is deduplicated before matching: it adds no review item, however often', async () => {
      await whatsapp('wamid.f1', 'already_confirmed');
      for (const id of ['wamid.f2', 'wamid.f3', 'wamid.f4']) await whatsapp(id, 'already_confirmed');
      expect(await db.document.count({ where: { status: 'NEEDS_REVIEW' } })).toBe(1);
    });

    it('a sender can only reach transactions in their own scope: a stranger\'s copy of someone else\'s receipt is not offered that transaction', async () => {
      await whatsapp('wamid.s1', 'exact'); // confirms txn_exact for driver 1
      await whatsapp('wamid.s2', 'exact', '966502222222'); // driver 2 (same client) sends the same receipt
      const stranger = await docOf('wamid.s2');
      expect(stranger.status).toBe('UNMATCHED');
      expect(stranger.matches).toHaveLength(0);
    });

    it('DIFFERENT bytes of the same receipt (re-photographed) each cost one review item: a registered sender can do this, bounded by who they are', async () => {
      await whatsapp('wamid.d1', 'exact');
      // a stand-in extractor that reads every file as the `exact` receipt, like a real OCR reading three photos of one slip
      const extractor: DocumentExtractor = { extract: async () => fixtureExpected('exact') };
      const { deps, drain } = makeDeps(db);
      deps.ingestion = createIngestionService({ db, extractor, blobs: new InMemoryBlobStore(), log: silentLogger });
      for (const id of ['wamid.d2', 'wamid.d3', 'wamid.d4']) {
        const payload = emailPayload(id, ['exact']);
        payload.attachments[0]!.contentBase64 = Buffer.concat([fixtureBytes('exact'), Buffer.from(id)]).toString('base64');
        await handleEmailWebhook(signedRequest(EMAIL_URL, payload, SECRETS.email), deps);
      }
      await drain();
      expect(await db.document.count({ where: { status: 'NEEDS_REVIEW', matchReason: 'POSSIBLE_DUPLICATE' } })).toBe(3);
      // ...but they can never confirm anything: still exactly one confirmed document for the transaction
      expect(await db.documentMatch.count({ where: { transactionId: 'txn_exact', status: { in: ['AUTO_CONFIRMED', 'CONFIRMED'] } } })).toBe(1);
    });
  });
});
