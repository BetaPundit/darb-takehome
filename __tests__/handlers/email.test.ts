import type { PrismaClient } from '@/lib/generated/prisma/client';
import { handleEmailWebhook } from '@/lib/webhooks/handlers/email';
import { seedDatabase } from '@/prisma/seed-data';
import { createTestDb } from '../helpers/test-db';
import { emailPayload, makeDeps, SECRETS, signedRequest } from './helpers';

const URL_ = 'http://localhost/api/webhooks/email';

describe('POST /api/webhooks/email', () => {
  let db: PrismaClient;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ db, cleanup } = await createTestDb()));
  afterAll(() => cleanup());
  beforeEach(() => seedDatabase(db));

  const post = async (payload: unknown, opts: { secret?: string; tamper?: (raw: string) => string } = {}) => {
    const { deps, drain } = makeDeps(db);
    const res = await handleEmailWebhook(signedRequest(URL_, payload, opts.secret ?? SECRETS.email, 'x-signature-256', opts.tamper), deps);
    await drain();
    return { res, body: (await res.json()) as Record<string, unknown>, deps, drain };
  };

  it('happy path: 200 immediately, document processed and auto-matched afterwards', async () => {
    const { res, body } = await post(emailPayload('m-1', ['email_exact'], 'accounts@desertfleet.example'));
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: 'accepted', documents: [{ duplicate: false }] });
    const doc = await db.document.findFirstOrThrow({ where: { externalMessageId: 'm-1' }, include: { matches: true } });
    expect(doc).toMatchObject({ status: 'MATCHED', source: 'EMAIL', clientId: 'client_desert', scopeKey: 'client:client_desert' });
    expect(doc.matches[0]).toMatchObject({ transactionId: 'txn_email', status: 'AUTO_CONFIRMED' });
  });

  it('forged / missing / tampered signature => 401 and NOTHING stored', async () => {
    const payload = emailPayload('m-2', ['exact']);
    const wrongSecret = await post(payload, { secret: 'not-the-secret' });
    expect(wrongSecret.res.status).toBe(401);

    const { deps } = makeDeps(db);
    const unsigned = await handleEmailWebhook(new Request(URL_, { method: 'POST', body: JSON.stringify(payload) }), deps);
    expect(unsigned.status).toBe(401);

    // valid signature over the ORIGINAL body, but the body was altered in transit
    const tampered = await post(payload, { tamper: (raw) => raw.replace('m-2', 'm-X') });
    expect(tampered.res.status).toBe(401);

    expect(await db.document.count({ where: { externalMessageId: { in: ['m-2', 'm-X'] } } })).toBe(0);
  });

  it('malformed JSON and schema violations => 400 without echoing submitted values', async () => {
    const { deps } = makeDeps(db);
    const garbage = Buffer.from('{not json');
    const r1 = await handleEmailWebhook(signedRequest(URL_, garbage, SECRETS.email), deps);
    expect(r1.status).toBe(400);

    const bad = emailPayload('m-3', ['exact']);
    const { res, body } = await post({ ...bad, from: 'SECRET-VALUE-not-an-email', messageId: '' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(body)).not.toContain('SECRET-VALUE');
  });

  it('unknown sender => 200 ignored, nothing stored (cannot be scoped, must not fill the disk)', async () => {
    const { res, body } = await post(emailPayload('m-4', ['exact'], 'stranger@evil.example'));
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: 'ignored', reason: 'UNKNOWN_SENDER' });
    expect(await db.document.count({ where: { externalMessageId: 'm-4' } })).toBe(0);
  });

  it('sender matching is case-insensitive', async () => {
    const { body } = await post(emailPayload('m-5', ['exact'], 'AP@ALNOOR.EXAMPLE'));
    expect(body.status).toBe('accepted');
  });

  it('redelivery of the same message => 200, duplicate:true, one document, processed once', async () => {
    const payload = emailPayload('m-6', ['exact']);
    await post(payload);
    const second = await post(payload);
    expect(second.res.status).toBe(200);
    expect(second.body).toMatchObject({ documents: [{ duplicate: true }] });
    expect(await db.document.count({ where: { externalMessageId: 'm-6' } })).toBe(1);
    expect(await db.documentMatch.count({ where: { document: { externalMessageId: 'm-6' } } })).toBe(1);
  });

  it('same attachment under a new messageId => duplicate (content hash)', async () => {
    await post(emailPayload('m-7a', ['exact']));
    const { body } = await post(emailPayload('m-7b', ['exact']));
    expect(body).toMatchObject({ documents: [{ duplicate: true }] });
  });

  it('multiple attachments => one document each', async () => {
    const { body } = await post(emailPayload('m-8', ['exact', 'rounding']));
    expect((body.documents as unknown[]).length).toBe(2);
  });

  it('extractor failure is NOT a webhook error: 200 now, document FAILED later', async () => {
    const { res } = await post(emailPayload('m-9', ['forced_failure']));
    expect(res.status).toBe(200);
    expect((await db.document.findFirstOrThrow({ where: { externalMessageId: 'm-9' } })).status).toBe('FAILED');
  });

  it('garbage extraction => 200, document UNMATCHED', async () => {
    const { res } = await post(emailPayload('m-10', ['garbage']));
    expect(res.status).toBe(200);
    expect((await db.document.findFirstOrThrow({ where: { externalMessageId: 'm-10' } })).status).toBe('UNMATCHED');
  });

  it('invalid base64 => 400 naming the field, oversized body => 413', async () => {
    const bad = emailPayload('m-11', ['exact']);
    bad.attachments[0]!.contentBase64 = 'not base64 !!!';
    const r = await post(bad);
    expect(r.res.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain('attachments.0.contentBase64');

    const { deps } = makeDeps(db, { env: { MAX_BODY_BYTES: '200' } }); // fixtures are ~20 bytes, so 3 of them + JSON overhead exceed 200
    const big = await handleEmailWebhook(signedRequest(URL_, emailPayload('m-12', ['exact', 'rounding', 'tip']), SECRETS.email), deps);
    expect(big.status).toBe(413);
    expect(await db.document.count({ where: { externalMessageId: 'm-12' } })).toBe(0);
  });

  it('infrastructure failure before acceptance => 503 + Retry-After (never 500)', async () => {
    const { deps } = makeDeps(db);
    deps.ingestion = { ...deps.ingestion, accept: () => Promise.reject(new Error('disk full')) };
    const res = await handleEmailWebhook(signedRequest(URL_, emailPayload('m-13', ['exact']), SECRETS.email), deps);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });
});
