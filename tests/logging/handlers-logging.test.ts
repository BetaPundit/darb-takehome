import type { PrismaClient } from '@/lib/generated/prisma/client';
import { FixtureMediaFetcher } from '@/lib/services/fixture-media-fetcher';
import { MediaFetchError, type MediaFetcher } from '@/lib/services/media-fetcher';
import { handleEmailWebhook } from '@/lib/webhooks/handlers/email';
import { handleTransactionsWebhook } from '@/lib/webhooks/handlers/transactions';
import { handleWhatsAppWebhook } from '@/lib/webhooks/handlers/whatsapp';
import { FIXTURES, type FixtureName } from '@/lib/extraction/fixtures';
import { seedDatabase } from '@/prisma/seed-data';
import { createTestDb } from '../helpers/test-db';
import { emailPayload, makeDeps, SECRETS, signedRequest, waPayload } from '../handlers/helpers';
import { createCapturingLogger } from './capture';

const EMAIL = 'http://localhost/api/webhooks/email';
const WA = 'http://localhost/api/webhooks/whatsapp';
const TX = 'http://localhost/api/webhooks/transactions';

describe('webhook logging', () => {
  let db: PrismaClient;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ db, cleanup } = await createTestDb()));
  afterAll(() => cleanup());
  beforeEach(() => seedDatabase(db));

  it('a forged signature is logged as a rejection with its reason and a requestId, and nothing about the payload', async () => {
    const log = createCapturingLogger();
    const { deps } = makeDeps(db, { log });
    const res = await handleEmailWebhook(signedRequest(EMAIL, emailPayload('<m1@mail.example>', ['exact']), 'wrong-secret'), deps);
    expect(res.status).toBe(401);
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({ level: 'warn', event: 'webhook.rejected', fields: { reason: 'bad_signature', endpoint: 'email' } });
    expect(log.entries[0]!.fields.requestId).toEqual(expect.any(String));
  });

  it.each([
    ['invalid_payload', () => signedRequest(EMAIL, Buffer.from('{not json'), SECRETS.email), handleEmailWebhook],
    ['too_large', () => signedRequest(EMAIL, emailPayload('<m2@mail.example>', ['exact', 'rounding', 'tip']), SECRETS.email), handleEmailWebhook],
  ] as const)('rejection reason %s is logged', async (reason, build, handler) => {
    const log = createCapturingLogger();
    const { deps } = makeDeps(db, { log, env: reason === 'too_large' ? { MAX_BODY_BYTES: '200' } : {} });
    await handler(build(), deps);
    expect(log.entries.map((e) => [e.event, e.fields.reason])).toEqual([['webhook.rejected', reason]]);
  });

  it('an accepted message logs counts and the message id, and the background processing shares the same requestId', async () => {
    const log = createCapturingLogger();
    const { deps, drain } = makeDeps(db, { log });
    await handleEmailWebhook(signedRequest(EMAIL, emailPayload('<m3@mail.example>', ['email_exact'], 'accounts@desertfleet.example'), SECRETS.email), deps);
    await drain();

    const accepted = log.entries.find((e) => e.event === 'webhook.accepted')!;
    expect(accepted.fields).toMatchObject({ messageId: '<m3@mail.example>', documents: 1, duplicates: 0, endpoint: 'email' });

    const processed = log.entries.find((e) => e.event === 'document.processed')!;
    expect(processed.fields).toMatchObject({ outcome: 'AUTO_MATCHED', reason: 'CLEAR_WINNER', source: 'EMAIL' });
    expect(processed.fields.documentId).toEqual(expect.any(String));
    expect(processed.fields.requestId).toBe(accepted.fields.requestId); // the thread that ties one message together
    for (const k of ['extractionMs', 'matchMs', 'durationMs']) expect(processed.fields[k]).toEqual(expect.any(Number));
  });

  it('a redelivery logs duplicates, not a second document', async () => {
    const log = createCapturingLogger();
    const { deps, drain } = makeDeps(db, { log });
    const send = () => handleEmailWebhook(signedRequest(EMAIL, emailPayload('<m4@mail.example>', ['exact']), SECRETS.email), deps);
    await send();
    await drain();
    log.entries.length = 0;
    await send();
    expect(log.entries.find((e) => e.event === 'webhook.accepted')!.fields).toMatchObject({ documents: 0, duplicates: 1 });
    expect(log.entries.some((e) => e.event === 'document.processed')).toBe(false);
  });

  it('a WhatsApp media failure that asks Meta to retry is logged at error/warn with the status, not the token or URL', async () => {
    const log = createCapturingLogger();
    const media: MediaFetcher = { download: () => Promise.reject(new MediaFetchError('HTTP_ERROR', false, 'token abc123 expired at https://secret.example/x', 401)) };
    const { deps } = makeDeps(db, { log, media });
    const res = await handleWhatsAppWebhook(signedRequest(WA, waPayload([{ id: 'wamid.L1', from: '966501111111' }]), SECRETS.whatsapp, 'x-hub-signature-256'), deps);
    expect(res.status).toBe(503);
    expect(log.entries.map((e) => e.event)).toEqual(['webhook.media_retryable', 'webhook.retry_requested']);
    expect(log.entries[0]!.fields).toMatchObject({ messageId: 'wamid.L1', code: 'HTTP_ERROR', status: 401 });
    expect(JSON.stringify(log.entries)).not.toMatch(/abc123|secret\.example/);
  });

  it('SENSITIVE DATA: a full run through every webhook never logs phone numbers, sender addresses, merchants, OCR text or secrets', async () => {
    const log = createCapturingLogger();
    const { deps, drain } = makeDeps(db, { log });

    const names = Object.keys(FIXTURES) as FixtureName[];
    for (const [i, name] of names.entries()) {
      await handleWhatsAppWebhook(signedRequest(WA, waPayload([{ id: `wamid.S${i}`, from: i % 2 ? '966502222222' : '966501111111', media: `fixture:${name}` }]), SECRETS.whatsapp, 'x-hub-signature-256'), deps);
      await handleEmailWebhook(signedRequest(EMAIL, emailPayload(`<s${i}@mail.example>`, [name]), SECRETS.email), deps);
    }
    await handleEmailWebhook(signedRequest(EMAIL, emailPayload('<stranger@mail.example>', ['exact'], 'stranger@evil.example'), SECRETS.email), deps);
    await handleEmailWebhook(signedRequest(EMAIL, emailPayload('<forged@mail.example>', ['exact']), 'wrong'), deps);
    await handleTransactionsWebhook(signedRequest(TX, [{ externalRef: 'log-1', clientId: 'client_alnoor', driverPhone: '0501111111', merchantName: 'SAUDI ELECTRICITY CO', amountMinor: 99999, currency: 'SAR', occurredAt: '2026-10-02T10:00:00+03:00' }], SECRETS.transactions), deps);
    await drain();

    expect(log.entries.length).toBeGreaterThan(20); // we really did log things
    const everything = JSON.stringify(log.entries);

    const mustNeverAppear = [
      '966501111111', '966502222222', '966503333333', // driver phones, with or without +
      'ap@alnoor.example', 'accounts@desertfleet.example', 'stranger@evil.example', // sender addresses
      'Aramco', 'Starbucks', 'Al Baik', 'ADNOC', 'Jarir', 'Panda', 'Nadec', 'SASCO', 'Electricity', 'مطعم', // merchants
      SECRETS.email, SECRETS.whatsapp, SECRETS.transactions, 'sha256=', // secrets and signatures
      'DARB-FIXTURE', // fixture bytes
    ];
    for (const needle of mustNeverAppear) expect(everything).not.toContain(needle);

    // and the rejections we expect are present
    expect(log.entries.filter((e) => e.event === 'webhook.rejected').map((e) => e.fields.reason)).toContain('bad_signature');
    expect(log.entries.some((e) => e.event === 'webhook.ignored' && e.fields.reason === 'unknown_sender')).toBe(true);
    // a media fetcher that works, to make sure the run above was not vacuous
    expect(await new FixtureMediaFetcher().download('fixture:exact')).toBeTruthy();
  });
});
