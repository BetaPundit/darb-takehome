import type { PrismaClient } from '@/lib/generated/prisma/client';
import { FixtureMediaFetcher } from '@/lib/services/fixture-media-fetcher';
import { MediaFetchError, type MediaFetcher } from '@/lib/services/media-fetcher';
import { handleWhatsAppVerify, handleWhatsAppWebhook } from '@/lib/webhooks/handlers/whatsapp';
import { seedDatabase } from '@/prisma/seed-data';
import { createTestDb } from '../helpers/test-db';
import { makeDeps, SECRETS, signedRequest, waPayload } from './helpers';

const URL_ = 'http://localhost/api/webhooks/whatsapp';
const SIG = 'x-hub-signature-256';
const DRIVER1 = '966501111111'; // Meta sends digits without '+'

describe('WhatsApp webhook', () => {
  let db: PrismaClient;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ db, cleanup } = await createTestDb()));
  afterAll(() => cleanup());
  beforeEach(() => seedDatabase(db));

  describe('GET handshake', () => {
    const verify = (qs: string) => handleWhatsAppVerify(new Request(`${URL_}?${qs}`), makeDeps(db).deps);
    it('echoes the challenge as plain text for the right token', async () => {
      const res = verify(`hub.mode=subscribe&hub.verify_token=${SECRETS.verify}&hub.challenge=1158201444`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('1158201444');
      expect(res.headers.get('content-type')).toContain('text/plain');
    });
    it.each([
      ['wrong token', `hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`],
      ['wrong mode', `hub.mode=unsubscribe&hub.verify_token=${SECRETS.verify}&hub.challenge=1`],
      ['missing params', ''],
      ['script in challenge (reflected-XSS shape)', `hub.mode=subscribe&hub.verify_token=${SECRETS.verify}&hub.challenge=<script>alert(1)</script>`],
    ])('403 for %s', (_n, qs) => expect(verify(qs).status).toBe(403));
  });

  describe('POST', () => {
    const post = async (payload: unknown, deps = makeDeps(db), secret = SECRETS.whatsapp) => {
      const res = await handleWhatsAppWebhook(signedRequest(URL_, payload, secret, SIG), deps.deps);
      await deps.drain();
      return { res, body: (await res.json()) as Record<string, unknown> };
    };
    const countingMedia = (inner: MediaFetcher) => {
      const calls: string[] = [];
      return { calls, fetcher: { download: (id: string) => (calls.push(id), inner.download(id)) } as MediaFetcher };
    };
    const failingMedia = (err: MediaFetchError): MediaFetcher => ({ download: () => Promise.reject(err) });

    it('image message: phone-scoped document created, processed and auto-matched', async () => {
      const { res, body } = await post(waPayload([{ id: 'wamid.A', from: DRIVER1, media: 'fixture:exact' }]));
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ status: 'accepted', documents: 1 });
      const doc = await db.document.findFirstOrThrow({ where: { externalMessageId: 'wamid.A' }, include: { matches: true } });
      expect(doc).toMatchObject({ source: 'WHATSAPP', scopeKey: 'phone:+966501111111', status: 'MATCHED', clientId: null });
      expect(doc.matches[0]).toMatchObject({ transactionId: 'txn_exact', status: 'AUTO_CONFIRMED' });
    });

    it('bad or missing signature => 401, no media download, nothing stored', async () => {
      const media = countingMedia(new FixtureMediaFetcher());
      const deps = makeDeps(db, { media: media.fetcher });
      const forged = await post(waPayload([{ id: 'wamid.B', from: DRIVER1 }]), deps, 'attacker-secret');
      expect(forged.res.status).toBe(401);
      const unsigned = await handleWhatsAppWebhook(new Request(URL_, { method: 'POST', body: JSON.stringify(waPayload([{ id: 'wamid.B', from: DRIVER1 }])) }), deps.deps);
      expect(unsigned.status).toBe(401);
      expect(media.calls).toEqual([]);
      expect(await db.document.count({ where: { externalMessageId: 'wamid.B' } })).toBe(0);
    });

    it('status-only, text-only and wrong-shape-but-valid payloads are acknowledged and ignored', async () => {
      const statusOnly = { object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '1' }, statuses: [{ id: 'x', status: 'delivered' }] } }] }] };
      expect((await post(statusOnly)).body).toMatchObject({ status: 'ignored', reason: 'NO_MEDIA' });
      expect((await post(waPayload([{ id: 'wamid.T', from: DRIVER1, type: 'text' }]))).body).toMatchObject({ status: 'ignored' });
    });

    it('schema violation => 400', async () => {
      expect((await post({ object: 'something_else', entry: [] })).res.status).toBe(400);
    });

    it('redelivery of the same wamid does NOT download the media again and creates nothing new', async () => {
      const media = countingMedia(new FixtureMediaFetcher());
      const payload = waPayload([{ id: 'wamid.C', from: DRIVER1, media: 'fixture:exact' }]);
      await post(payload, makeDeps(db, { media: media.fetcher }));
      const again = await post(payload, makeDeps(db, { media: media.fetcher }));
      expect(again.res.status).toBe(200);
      expect(media.calls).toHaveLength(1);
      expect(await db.document.count({ where: { externalMessageId: 'wamid.C' } })).toBe(1);
    });

    it('same photo forwarded under a new wamid by the same driver is a duplicate (content hash)', async () => {
      await post(waPayload([{ id: 'wamid.D1', from: DRIVER1, media: 'fixture:exact' }]));
      const { body } = await post(waPayload([{ id: 'wamid.D2', from: DRIVER1, media: 'fixture:exact' }]));
      expect(body).toMatchObject({ status: 'accepted', documents: 0 });
      expect(await db.document.count({ where: { externalMessageId: { in: ['wamid.D1', 'wamid.D2'] } } })).toBe(1);
    });

    it('retryable media failure (network/5xx/429) => 503 so Meta redelivers', async () => {
      const res = await post(waPayload([{ id: 'wamid.E', from: DRIVER1 }]), makeDeps(db, { media: failingMedia(new MediaFetchError('NETWORK', true, 'x')) }));
      expect(res.res.status).toBe(503);
      expect(res.res.headers.get('retry-after')).toBeTruthy();
    });

    it('OUR token expired (401/403 from Graph) is also retried, not silently dropped', async () => {
      const res = await post(waPayload([{ id: 'wamid.F', from: DRIVER1 }]), makeDeps(db, { media: failingMedia(new MediaFetchError('HTTP_ERROR', false, 'x', 401)) }));
      expect(res.res.status).toBe(503);
    });

    it('permanent media failure (expired media, 404) => 200 skipped: redelivery would never succeed', async () => {
      const res = await post(waPayload([{ id: 'wamid.G', from: DRIVER1 }]), makeDeps(db, { media: failingMedia(new MediaFetchError('HTTP_ERROR', false, 'x', 404)) }));
      expect(res.res.status).toBe(200);
      expect(res.body).toMatchObject({ skipped: 1 });
    });

    it('partial batch: one message accepted, one fails retryably => 503, and the redelivery does not duplicate the first', async () => {
      let flaky = true;
      const media: MediaFetcher = {
        download: (id) => (id === 'fixture:rounding' && flaky ? Promise.reject(new MediaFetchError('TIMEOUT', true, 'slow')) : new FixtureMediaFetcher().download(id)),
      };
      const payload = waPayload([
        { id: 'wamid.H1', from: DRIVER1, media: 'fixture:exact' },
        { id: 'wamid.H2', from: '966502222222', media: 'fixture:rounding' },
      ]);
      expect((await post(payload, makeDeps(db, { media }))).res.status).toBe(503);
      expect(await db.document.count({ where: { externalMessageId: 'wamid.H1' } })).toBe(1);

      flaky = false; // Meta redelivers the whole payload
      expect((await post(payload, makeDeps(db, { media }))).res.status).toBe(200);
      expect(await db.document.count({ where: { externalMessageId: 'wamid.H1' } })).toBe(1);
      expect(await db.document.count({ where: { externalMessageId: 'wamid.H2' } })).toBe(1);
    });

    it('non-allowed mime types (e.g. audio, docx) are skipped without a download', async () => {
      const media = countingMedia(new FixtureMediaFetcher());
      const { body } = await post(waPayload([{ id: 'wamid.I', from: DRIVER1, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }]), makeDeps(db, { media: media.fetcher }));
      expect(body).toMatchObject({ skipped: 1, documents: 0 });
      expect(media.calls).toEqual([]);
    });

    it('extractor failure is invisible to Meta: 200, document FAILED', async () => {
      const { res } = await post(waPayload([{ id: 'wamid.J', from: DRIVER1, media: 'fixture:forced_failure' }]));
      expect(res.status).toBe(200);
      expect((await db.document.findFirstOrThrow({ where: { externalMessageId: 'wamid.J' } })).status).toBe('FAILED');
    });

    it('a driver can only match their OWN transactions: another driver sending the same receipt stays UNMATCHED', async () => {
      await post(waPayload([{ id: 'wamid.K', from: '966502222222', media: 'fixture:exact' }])); // txn_exact belongs to driver 1
      expect((await db.document.findFirstOrThrow({ where: { externalMessageId: 'wamid.K' } })).status).toBe('UNMATCHED');
    });
  });
});
