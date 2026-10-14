import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defaultFixturesDir } from '@/lib/extraction/fixtures';
import type { PrismaClient } from '@/lib/generated/prisma/client';
import { handleEmailWebhook } from '@/lib/webhooks/handlers/email';
import { handleWhatsAppWebhook } from '@/lib/webhooks/handlers/whatsapp';
import { emailWebhookSchema, whatsappWebhookSchema } from '@/lib/webhooks/schemas';
import { seedDatabase } from '@/prisma/seed-data';
import { createTestDb } from '../helpers/test-db';
import { makeDeps, SECRETS, signedRequest } from './helpers';

/**
 * The assignment's own sample payloads (fixtures/webhooks/*.json, plus the two samples verbatim below) through the real
 * Zod schemas and the real handlers against the seeded database.
 */
const WEBHOOKS_DIR = path.join(defaultFixturesDir(), 'webhooks');
const EMAIL_URL = 'http://localhost/api/webhooks/email';
const WA_URL = 'http://localhost/api/webhooks/whatsapp';
const readSample = (file: string): unknown => JSON.parse(readFileSync(path.join(WEBHOOKS_DIR, file), 'utf8'));

/** The assignment text, character for character, including the `<base64>` placeholder and the elided wamid / sha256. */
const ASSIGNMENT_EMAIL_VERBATIM =
  '{"messageId":"msg_8f2a1","from":"billing@alfanar-fuel.com.sa","to":"receipts@darb.example.com","subject":"Tax Invoice #INV-99812","receivedAt":"2025-06-14T09:21:00Z","attachments":[{"filename":"invoice-99812.pdf","contentType":"application/pdf","contentBase64":"<base64>"}]}';
const ASSIGNMENT_WHATSAPP_VERBATIM =
  '{"entry":[{"changes":[{"value":{"messages":[{"id":"wamid.HBgMOTY2NT...","from":"966551234567","timestamp":"1718356881","type":"image","image":{"id":"media_4471","mime_type":"image/jpeg","sha256":"a3f1c9..."}}]}}]}]}';

interface Expected {
  channel: 'email' | 'whatsapp';
  status: number;
  /** body fields */
  body: Record<string, unknown>;
  /** the stored document, or null when nothing may be stored */
  document: null | { docStatus: string; reason: string; matches: string[]; flags?: string[] };
}

/** One entry per file in fixtures/webhooks: a new sample without an expectation here fails the test below. */
const EXPECTED: Record<string, Expected> = {
  'email-alfanar-invoice.json': { channel: 'email', status: 200, body: { status: 'accepted' }, document: { docStatus: 'MATCHED', reason: 'CLEAR_WINNER', matches: ['txn_alfanar:AUTO_CONFIRMED'] } },
  // 966551234567 is not a driver of any seeded transaction: accepted, extracted, and nothing in scope to match
  'whatsapp-spec-sample.json': { channel: 'whatsapp', status: 200, body: { status: 'accepted', documents: 1 }, document: { docStatus: 'UNMATCHED', reason: 'NO_CANDIDATES_IN_SCOPE', matches: [] } },
  'whatsapp-exact-seeded-driver.json': { channel: 'whatsapp', status: 200, body: { status: 'accepted', documents: 1 }, document: { docStatus: 'MATCHED', reason: 'CLEAR_WINNER', matches: ['txn_exact:AUTO_CONFIRMED'] } },
  'whatsapp-restaurant-tip.json': { channel: 'whatsapp', status: 200, body: { status: 'accepted', documents: 1 }, document: { docStatus: 'NEEDS_REVIEW', reason: 'BELOW_AUTO_THRESHOLD', matches: ['txn_restaurant:CANDIDATE'], flags: ['TIP_SUSPECTED'] } },
  'whatsapp-garbage.json': { channel: 'whatsapp', status: 200, body: { status: 'accepted', documents: 1 }, document: { docStatus: 'UNMATCHED', reason: 'INSUFFICIENT_DATA', matches: [] } },
  'whatsapp-unknown-media.json': { channel: 'whatsapp', status: 200, body: { status: 'accepted', documents: 0, skipped: 1 }, document: null },
};

const files = readdirSync(WEBHOOKS_DIR).filter((f) => f.endsWith('.json')).sort();

describe('fixtures/webhooks: the sample bodies', () => {
  it('every file has an expectation (and every expectation has a file)', () => {
    expect(files).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(files)('%s passes the schema of its channel', (file) => {
    const schema = EXPECTED[file]!.channel === 'email' ? emailWebhookSchema : whatsappWebhookSchema;
    const result = schema.safeParse(readSample(file));
    expect(result.success).toBe(true);
  });

  it('whatsapp-spec-sample.json IS the assignment\'s WhatsApp sample (same JSON, no envelope extras added)', () => {
    expect(readSample('whatsapp-spec-sample.json')).toEqual(JSON.parse(ASSIGNMENT_WHATSAPP_VERBATIM));
  });

  it('email-alfanar-invoice.json is the assignment\'s email sample with real bytes in place of "<base64>"', () => {
    const { attachments, ...rest } = readSample('email-alfanar-invoice.json') as { attachments: Record<string, unknown>[] };
    const { attachments: assignmentAttachments, ...assignmentRest } = JSON.parse(ASSIGNMENT_EMAIL_VERBATIM) as { attachments: Record<string, unknown>[] };
    expect(rest).toEqual(assignmentRest);
    expect(attachments).toHaveLength(1);
    const { contentBase64, ...attachment } = attachments[0]!;
    const { contentBase64: placeholder, ...assignmentAttachment } = assignmentAttachments[0]!;
    expect(attachment).toEqual(assignmentAttachment);
    expect(placeholder).toBe('<base64>');
    expect(contentBase64).not.toBe(placeholder);
  });
});

describe('fixtures/webhooks through the real handlers and the seeded database', () => {
  let db: PrismaClient;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ db, cleanup } = await createTestDb()));
  afterAll(() => cleanup());
  beforeEach(() => seedDatabase(db));

  async function send(channel: Expected['channel'], payload: unknown) {
    const { deps, drain } = makeDeps(db);
    const req =
      channel === 'email'
        ? signedRequest(EMAIL_URL, payload, SECRETS.email, 'x-signature-256')
        : signedRequest(WA_URL, payload, SECRETS.whatsapp, 'x-hub-signature-256');
    const res = await (channel === 'email' ? handleEmailWebhook : handleWhatsAppWebhook)(req, deps);
    await drain();
    return { res, body: (await res.json()) as Record<string, unknown> };
  }

  it.each(files)('%s', async (file) => {
    const expected = EXPECTED[file]!;
    const { res, body } = await send(expected.channel, readSample(file));

    expect(res.status).toBe(expected.status);
    expect(body).toMatchObject(expected.body);

    const docs = await db.document.findMany({ where: { id: { not: 'doc_seed_confirmed' } }, include: { matches: { orderBy: { rank: 'asc' } } } });
    if (expected.document === null) {
      expect(docs).toHaveLength(0);
      return;
    }
    expect(docs).toHaveLength(1);
    const doc = docs[0]!;
    expect(doc).toMatchObject({ status: expected.document.docStatus, matchReason: expected.document.reason });
    expect(doc.matches.filter((m) => m.status !== 'REJECTED').map((m) => `${m.transactionId}:${m.status}`)).toEqual(expected.document.matches);
    if (expected.document.flags) expect((doc.matches[0]!.signals as { flags: string[] }).flags).toEqual(expected.document.flags);
  });

  describe('the assignment samples VERBATIM', () => {
    it('WhatsApp: no object / entry.id / field / messaging_product / metadata, and the elided wamid and sha256 -> 200, stored, UNMATCHED (the number is not a seeded driver)', async () => {
      const { res, body } = await send('whatsapp', JSON.parse(ASSIGNMENT_WHATSAPP_VERBATIM));
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ status: 'accepted', documents: 1 });
      const doc = await db.document.findFirstOrThrow({ where: { externalMessageId: 'wamid.HBgMOTY2NT...' } });
      expect(doc).toMatchObject({ source: 'WHATSAPP', scopeKey: 'phone:+966551234567', status: 'UNMATCHED' });
    });

    it('email: the literal "<base64>" placeholder is a clean 400 naming attachments.0.contentBase64, never a 500, and nothing is stored', async () => {
      const { res, body } = await send('email', JSON.parse(ASSIGNMENT_EMAIL_VERBATIM));
      expect(res.status).toBe(400);
      expect(body).toEqual({ status: 'invalid', issues: [{ path: 'attachments.0.contentBase64', message: 'INVALID_BASE64' }] });
      expect(await db.document.count({ where: { externalMessageId: 'msg_8f2a1' } })).toBe(0);
    });

    it('email: the same placeholder as raw signed bytes (what a real provider would POST) gives the same 400', async () => {
      const { deps } = makeDeps(db);
      const res = await handleEmailWebhook(signedRequest(EMAIL_URL, Buffer.from(ASSIGNMENT_EMAIL_VERBATIM), SECRETS.email), deps);
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain('attachments.0.contentBase64');
    });

    it('email with the real bytes substituted for the placeholder (the sample as the assignment intends it): 200, auto-matched to txn_alfanar', async () => {
      const real = readSample('email-alfanar-invoice.json') as { attachments: { contentBase64: string }[] };
      const body = JSON.parse(ASSIGNMENT_EMAIL_VERBATIM) as { attachments: { contentBase64: string }[] };
      body.attachments[0]!.contentBase64 = real.attachments[0]!.contentBase64;
      const { res } = await send('email', body);
      expect(res.status).toBe(200);
      const doc = await db.document.findFirstOrThrow({ where: { externalMessageId: 'msg_8f2a1' }, include: { matches: true } });
      expect(doc.status).toBe('MATCHED');
      expect(doc.matches[0]).toMatchObject({ transactionId: 'txn_alfanar', status: 'AUTO_CONFIRMED' });
    });
  });
});
