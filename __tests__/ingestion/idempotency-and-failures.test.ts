import { fixtureBytes, FIXTURES } from '@/lib/extraction/fixtures';
import type { DocumentExtractor, ExtractedDocument } from '@/lib/extraction/types';
import type { PrismaClient } from '@/lib/generated/prisma/client';
import { seedDatabase } from '@/prisma/seed-data';
import { createTestDb } from '../helpers/test-db';
import { DRIVER_1, DRIVER_2, makeService, nextMessageId, sendFixture } from './helpers';

const exactExtraction = (FIXTURES.exact as { expected: ExtractedDocument }).expected;
const jpeg = (text: string) => ({ fileName: 'x.jpg', mimeType: 'image/jpeg', bytes: Buffer.from(text) });

describe('ingestion: idempotency, failures, concurrency, recovery', () => {
  let db: PrismaClient;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ db, cleanup } = await createTestDb()));
  afterAll(() => cleanup());
  beforeEach(() => seedDatabase(db));

  describe('accept(): duplicates', () => {
    it('stores a new document as RECEIVED with its bytes in the blob store', async () => {
      const { service, blobs } = makeService(db);
      const [r] = await service.accept({ source: 'WHATSAPP', externalMessageId: 'wamid.1', scope: DRIVER_1, attachments: [jpeg('a')] });
      expect(r!.duplicate).toBe(false);
      const doc = await db.document.findUniqueOrThrow({ where: { id: r!.documentId } });
      expect(doc).toMatchObject({ status: 'RECEIVED', scopeKey: 'phone:+966501111111', senderRef: '+966501111111', clientId: null });
      expect((await blobs.get(doc.blobKey)).toString()).toBe('a');
    });

    it('same provider message id redelivered => duplicate, one row', async () => {
      const { service } = makeService(db);
      const input = { source: 'WHATSAPP' as const, externalMessageId: 'wamid.1', scope: DRIVER_1, attachments: [jpeg('a')] };
      const [first] = await service.accept(input);
      const [second] = await service.accept(input);
      expect(second).toEqual({ documentId: first!.documentId, duplicate: true });
      expect(await db.document.count({ where: { externalMessageId: 'wamid.1' } })).toBe(1);
    });

    it('same bytes under a NEW message id, same sender => duplicate (content hash)', async () => {
      const { service } = makeService(db);
      const [first] = await service.accept({ source: 'WHATSAPP', externalMessageId: 'wamid.1', scope: DRIVER_1, attachments: [jpeg('same')] });
      const [second] = await service.accept({ source: 'WHATSAPP', externalMessageId: 'wamid.2', scope: DRIVER_1, attachments: [jpeg('same')] });
      expect(second).toEqual({ documentId: first!.documentId, duplicate: true });
    });

    it('same bytes from a DIFFERENT sender is NOT a duplicate (dedupe is per scope)', async () => {
      const { service } = makeService(db);
      const [a] = await service.accept({ source: 'WHATSAPP', externalMessageId: 'wamid.1', scope: DRIVER_1, attachments: [jpeg('same')] });
      const [b] = await service.accept({ source: 'WHATSAPP', externalMessageId: 'wamid.2', scope: DRIVER_2, attachments: [jpeg('same')] });
      expect(b!.duplicate).toBe(false);
      expect(b!.documentId).not.toBe(a!.documentId);
    });

    it('CONCURRENT identical submissions: exactly one row, exactly one non-duplicate', async () => {
      const { service } = makeService(db);
      const input = { source: 'EMAIL' as const, externalMessageId: '<abc@mail>', scope: { kind: 'EMAIL' as const, clientId: 'client_alnoor', email: 'ap@alnoor.example' }, attachments: [jpeg('race')] };
      const results = await Promise.all(Array.from({ length: 8 }, () => service.accept(input)));
      const flat = results.flat();
      expect(flat.filter((r) => !r.duplicate)).toHaveLength(1);
      expect(new Set(flat.map((r) => r.documentId)).size).toBe(1);
      expect(await db.document.count({ where: { externalMessageId: '<abc@mail>' } })).toBe(1);
    });

    it('multi-attachment email creates one document per attachment, each independently deduped', async () => {
      const { service } = makeService(db);
      const scope = { kind: 'EMAIL' as const, clientId: 'client_alnoor', email: 'ap@alnoor.example' };
      const two = await service.accept({ source: 'EMAIL', externalMessageId: 'm1', scope, attachments: [jpeg('one'), jpeg('two')] });
      expect(two.map((r) => r.duplicate)).toEqual([false, false]);
      const again = await service.accept({ source: 'EMAIL', externalMessageId: 'm1', scope, attachments: [jpeg('one'), jpeg('two')] });
      expect(again.map((r) => r.duplicate)).toEqual([true, true]);
    });

    it('a duplicate fixture sent twice is only processed once', async () => {
      const { service } = makeService(db);
      const first = await sendFixture(service, 'exact', DRIVER_1, 'dup-1');
      const second = await sendFixture(service, 'exact', DRIVER_1, 'dup-2');
      expect(second.documentId).toBe(first.documentId);
      expect(second.result).toEqual({ status: 'SKIPPED' }); // already processed
      expect(await db.documentMatch.count({ where: { status: 'AUTO_CONFIRMED' } })).toBe(1); // matched once (the seeded match is CONFIRMED)
    });
  });

  describe('processDocument(): extractor failures never throw and never 500', () => {
    const sendWith = async (extractor: DocumentExtractor, opts: { extractionTimeoutMs?: number } = {}) => {
      const { service } = makeService(db, { extractor, ...opts });
      const [r] = await service.accept({ source: 'WHATSAPP', externalMessageId: nextMessageId(), scope: DRIVER_1, attachments: [jpeg(nextMessageId())] });
      const result = await service.processDocument(r!.documentId);
      return { result, doc: await db.document.findUniqueOrThrow({ where: { id: r!.documentId } }), service, id: r!.documentId };
    };

    it('unknown file (no fixture) => FAILED UNKNOWN_FIXTURE', async () => {
      const { service } = makeService(db);
      const [r] = await service.accept({ source: 'WHATSAPP', externalMessageId: 'u', scope: DRIVER_1, attachments: [jpeg('not a fixture')] });
      expect(await service.processDocument(r!.documentId)).toEqual({ status: 'FAILED', reason: 'UNKNOWN_FIXTURE' });
    });

    it('extractor throws a random error => FAILED, and the error TEXT is not stored (it could echo document content)', async () => {
      const { doc, result } = await sendWith({ extract: () => Promise.reject(new Error('SECRET-DOCUMENT-TEXT 4111111111111111')) });
      expect(result).toEqual({ status: 'FAILED', reason: 'EXTRACTOR_ERROR' });
      expect(JSON.stringify(doc)).not.toContain('SECRET-DOCUMENT-TEXT');
    });

    it('extractor hangs => FAILED TIMEOUT at the pipeline deadline', async () => {
      const { result } = await sendWith({ extract: () => new Promise(() => {}) }, { extractionTimeoutMs: 25 });
      expect(result).toEqual({ status: 'FAILED', reason: 'TIMEOUT' });
    });

    it('extractor returns schema-invalid output => FAILED INVALID_OUTPUT, nothing reaches the matcher', async () => {
      const bad = { ...exactExtraction, totalAmount: 'lots' } as unknown as ExtractedDocument;
      const { result, doc } = await sendWith({ extract: async () => bad });
      expect(result).toEqual({ status: 'FAILED', reason: 'INVALID_OUTPUT' });
      expect(doc.extraction).toBeNull();
    });

    it('blob missing at processing time => FAILED BLOB_MISSING', async () => {
      const { service, blobs } = makeService(db);
      const [r] = await service.accept({ source: 'WHATSAPP', externalMessageId: 'b', scope: DRIVER_1, attachments: [jpeg('gone')] });
      const doc = await db.document.findUniqueOrThrow({ where: { id: r!.documentId } });
      blobs.get = () => Promise.reject(new Error('ENOENT'));
      expect(doc.blobKey).toBeTruthy();
      expect(await service.processDocument(r!.documentId)).toEqual({ status: 'FAILED', reason: 'BLOB_MISSING' });
    });

    it('retryFailed puts a FAILED document back through the pipeline', async () => {
      let healthy = false;
      const extractor: DocumentExtractor = { extract: async () => (healthy ? exactExtraction : Promise.reject(new Error('down'))) };
      const { service, id } = await sendWith(extractor);
      expect((await db.document.findUniqueOrThrow({ where: { id } })).status).toBe('FAILED');
      healthy = true;
      expect(await service.retryFailed(id)).toMatchObject({ status: 'DONE', outcome: 'AUTO_MATCHED' });
      expect((await db.document.findUniqueOrThrow({ where: { id } })).status).toBe('MATCHED');
      expect(await service.retryFailed(id)).toEqual({ status: 'SKIPPED' }); // not FAILED any more
    });
  });

  describe('processDocument(): concurrency and recovery', () => {
    it('two workers race on one document: extraction runs once, one DONE one SKIPPED', async () => {
      let calls = 0;
      const extractor: DocumentExtractor = { extract: async () => (calls++, exactExtraction) };
      const { service } = makeService(db, { extractor });
      const [r] = await service.accept({ source: 'WHATSAPP', externalMessageId: 'r', scope: DRIVER_1, attachments: [jpeg('r')] });
      const results = await Promise.all([service.processDocument(r!.documentId), service.processDocument(r!.documentId)]);
      expect(results.map((x) => x.status).sort()).toEqual(['DONE', 'SKIPPED']);
      expect(calls).toBe(1);
    });

    it('two DIFFERENT documents both want the same transaction: exactly one confirms, the other degrades safely', async () => {
      const extractor: DocumentExtractor = { extract: async () => exactExtraction };
      const { service } = makeService(db, { extractor });
      const ids = await Promise.all(
        ['one', 'two'].map(async (t) => (await service.accept({ source: 'WHATSAPP', externalMessageId: t, scope: DRIVER_1, attachments: [jpeg(t)] }))[0]!.documentId),
      );
      const results = await Promise.all(ids.map((id) => service.processDocument(id)));

      expect(results.every((r) => r.status === 'DONE')).toBe(true); // nobody threw
      expect(await db.documentMatch.count({ where: { transactionId: 'txn_exact', status: { in: ['AUTO_CONFIRMED', 'CONFIRMED'] } } })).toBe(1);
      const statuses = (await db.document.findMany({ where: { id: { in: ids } } })).map((d) => d.status).sort();
      expect(statuses).toEqual(['MATCHED', 'UNMATCHED']);
    });

    it('a fresh lease is respected, an expired lease is reclaimed', async () => {
      const t0 = new Date('2026-10-10T10:00:00Z');
      const { service } = makeService(db, { now: () => t0, leaseMs: 60_000 });
      const [r] = await service.accept({ source: 'WHATSAPP', externalMessageId: 'l', scope: DRIVER_1, attachments: [jpeg('l')] });
      await db.document.update({ where: { id: r!.documentId }, data: { processingStartedAt: new Date(t0.getTime() - 10_000) } });
      expect(await service.processDocument(r!.documentId)).toEqual({ status: 'SKIPPED' }); // someone is working on it

      await db.document.update({ where: { id: r!.documentId }, data: { processingStartedAt: new Date(t0.getTime() - 120_000) } });
      expect((await service.processDocument(r!.documentId)).status).toBe('FAILED'); // reclaimed (bytes aren't a fixture)
    });

    it('reprocessStale re-drives documents stuck in RECEIVED (process died between accept and process)', async () => {
      const { service } = makeService(db);
      await service.accept({ source: 'WHATSAPP', externalMessageId: 's', scope: DRIVER_1, attachments: [{ fileName: 'e.jpg', mimeType: 'image/jpeg', bytes: fixtureBytes('exact') }] });
      expect(await service.reprocessStale(60_000)).toBe(0); // too fresh
      await db.document.updateMany({ data: { receivedAt: new Date(Date.now() - 3_600_000) } });
      expect(await service.reprocessStale(60_000)).toBe(1);
      expect(await db.document.count({ where: { status: 'MATCHED', externalMessageId: 's' } })).toBe(1);
    });
  });
});
