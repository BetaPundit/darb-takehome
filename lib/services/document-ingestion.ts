import { sha256Hex } from '@/lib/extraction/hash';
import { ExtractionError, extractedDocumentSchema, type DocumentExtractor } from '@/lib/extraction/types';
import type { PrismaClient } from '@/lib/generated/prisma/client';
import { errorFields, type Logger } from '@/lib/logger';
import type { BlobStore } from '@/lib/services/blob-store';
import { ConcurrentModificationError, isUniqueViolation, matchAndPersist } from '@/lib/services/match-pipeline';

/**
 * Two phases, deliberately separate:
 *  A. accept()          fast and synchronous: dedupe, store bytes, insert Document(RECEIVED). The webhook answers after this.
 *  B. processDocument() slow: extract, match, persist. Idempotent, safe to call twice, safe to retry after a crash.
 * Phase B is a plain function so tests (and a stale-work sweeper) can call it directly; `after()` is only the trigger.
 */

export type SenderScope =
  | { kind: 'EMAIL'; clientId: string; email: string }
  | { kind: 'WHATSAPP'; phone: string }; // E.164

export interface IncomingAttachment {
  fileName: string;
  mimeType: string;
  bytes: Buffer;
}

export interface AcceptInput {
  source: 'EMAIL' | 'WHATSAPP';
  externalMessageId: string;
  scope: SenderScope;
  attachments: IncomingAttachment[];
}

export interface AcceptedDocument {
  documentId: string;
  duplicate: boolean;
}

export interface IngestDeps {
  db: PrismaClient;
  extractor: DocumentExtractor;
  blobs: BlobStore;
  log: Logger;
  now?: () => Date;
  /** Hard deadline on one extraction call (the extractor may also have its own). Default 30s. */
  extractionTimeoutMs?: number;
  /** A claimed document that has not finished after this long is considered abandoned. Default 5 min. */
  leaseMs?: number;
}

export type ProcessResult =
  | { status: 'SKIPPED' } // someone else owns it, or it is not in RECEIVED
  | { status: 'FAILED'; reason: string }
  | { status: 'DONE'; outcome: 'AUTO_MATCHED' | 'NEEDS_REVIEW' | 'UNMATCHED'; reason: string };

const scopeKeyOf = (scope: SenderScope) => (scope.kind === 'EMAIL' ? `client:${scope.clientId}` : `phone:${scope.phone}`);

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ExtractionError('TIMEOUT', `Extraction exceeded ${ms}ms`)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export function createIngestionService(deps: IngestDeps) {
  const { db, extractor, blobs } = deps;
  const now = deps.now ?? (() => new Date());
  const extractionTimeoutMs = deps.extractionTimeoutMs ?? 30_000;
  const leaseMs = deps.leaseMs ?? 300_000;

  /** Phase A. Throws only on infrastructure failure (DB / blob store down): the route turns that into 503 so the sender retries. */
  async function accept(input: AcceptInput): Promise<AcceptedDocument[]> {
    const scopeKey = scopeKeyOf(input.scope);
    const senderRef = input.scope.kind === 'EMAIL' ? input.scope.email : input.scope.phone;
    const clientId = input.scope.kind === 'EMAIL' ? input.scope.clientId : null;
    const results: AcceptedDocument[] = [];

    for (const [attachmentIndex, att] of input.attachments.entries()) {
      const contentHash = sha256Hex(att.bytes);
      // Either key means "we already have this": same provider message+slot, or same bytes from the same sender scope.
      const sameDocument = {
        OR: [
          { source: input.source, externalMessageId: input.externalMessageId, attachmentIndex },
          { scopeKey, contentHash },
        ],
      };

      const existing = await db.document.findFirst({ where: sameDocument, select: { id: true } });
      if (existing) {
        results.push({ documentId: existing.id, duplicate: true });
        continue;
      }

      // Content-addressed, so storing before the insert is harmless if the insert then loses a race.
      const blobKey = await blobs.put(contentHash, att.bytes);
      try {
        const created = await db.document.create({
          data: {
            source: input.source,
            externalMessageId: input.externalMessageId,
            attachmentIndex,
            scopeKey,
            contentHash,
            senderRef,
            clientId,
            blobKey,
            mimeType: att.mimeType,
          },
          select: { id: true },
        });
        results.push({ documentId: created.id, duplicate: false });
      } catch (err) {
        // Two concurrent requests passed the pre-check: the unique constraint decided. The loser is a duplicate, not an error.
        if (!isUniqueViolation(err)) throw err;
        const winner = await db.document.findFirst({ where: sameDocument, select: { id: true } });
        if (!winner) throw err;
        results.push({ documentId: winner.id, duplicate: true });
      }
    }
    return results;
  }

  async function fail(documentId: string, reason: string): Promise<ProcessResult> {
    await db.document.updateMany({
      where: { id: documentId, status: 'RECEIVED' },
      data: { status: 'FAILED', failureReason: reason, processingStartedAt: null },
    });
    return { status: 'FAILED', reason };
  }

  /** Phase B. Never throws for document-level problems (they become FAILED); throws only if the DB itself is unusable. */
  async function processDocument(documentId: string, opts: { log?: Logger } = {}): Promise<ProcessResult> {
    // The caller can pass a request-scoped logger so these lines carry the same requestId as the webhook that accepted it.
    const log = (opts.log ?? deps.log).child({ documentId });
    const started = Date.now();
    const t = now();

    // Claim: compare-and-set. Exactly one caller wins; others see count 0 and leave.
    const claimed = await db.document.updateMany({
      where: {
        id: documentId,
        status: 'RECEIVED',
        OR: [{ processingStartedAt: null }, { processingStartedAt: { lt: new Date(t.getTime() - leaseMs) } }],
      },
      data: { processingStartedAt: t },
    });
    if (claimed.count !== 1) return { status: 'SKIPPED' };

    const doc = await db.document.findUniqueOrThrow({ where: { id: documentId } });

    let bytes: Buffer;
    try {
      bytes = await blobs.get(doc.blobKey);
    } catch {
      log.error('document.blob_missing');
      return fail(documentId, 'BLOB_MISSING');
    }

    let extracted;
    const extractStart = Date.now();
    try {
      extracted = await withTimeout(extractor.extract(bytes, doc.mimeType), extractionTimeoutMs);
    } catch (err) {
      // Only the code is stored/logged: error messages from providers can echo document content.
      const reason = err instanceof ExtractionError ? err.code : 'EXTRACTOR_ERROR';
      log.warn('document.extraction_failed', { reason, extractionMs: Date.now() - extractStart });
      return fail(documentId, reason);
    }

    // Never trust an extractor, including our own: validate at the boundary before it reaches the DB or the matcher.
    const parsed = extractedDocumentSchema.safeParse(extracted);
    if (!parsed.success) {
      log.warn('document.extraction_invalid');
      return fail(documentId, 'INVALID_OUTPUT');
    }

    const moved = await db.document.updateMany({
      where: { id: documentId, status: 'RECEIVED' },
      data: { status: 'EXTRACTED', extraction: parsed.data, extractionConfidence: parsed.data.extractionConfidence },
    });
    if (moved.count !== 1) return { status: 'SKIPPED' };

    const extractionMs = Date.now() - extractStart;
    const matchStart = Date.now();
    try {
      const result = await matchAndPersist(db, documentId, 'EXTRACTED', t);
      log.info('document.processed', { source: doc.source, outcome: result.outcome, reason: result.reason, extractionMs, matchMs: Date.now() - matchStart, durationMs: Date.now() - started });
      return { status: 'DONE', outcome: result.outcome, reason: result.reason };
    } catch (err) {
      if (err instanceof ConcurrentModificationError) return { status: 'SKIPPED' };
      log.error('document.match_failed', errorFields(err));
      throw err;
    }
  }

  /** Crash recovery: documents still RECEIVED long after arrival (the process died between phase A and B). */
  async function reprocessStale(olderThanMs: number, limit = 50): Promise<number> {
    const stale = await db.document.findMany({
      where: { status: 'RECEIVED', receivedAt: { lt: new Date(now().getTime() - olderThanMs) } },
      orderBy: { receivedAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    let processed = 0;
    for (const { id } of stale) {
      if ((await processDocument(id)).status !== 'SKIPPED') processed++;
    }
    return processed;
  }

  /** Operator action: put a FAILED document back to RECEIVED and run it again. */
  async function retryFailed(documentId: string): Promise<ProcessResult> {
    const reset = await db.document.updateMany({
      where: { id: documentId, status: 'FAILED' },
      data: { status: 'RECEIVED', failureReason: null, processingStartedAt: null },
    });
    if (reset.count !== 1) return { status: 'SKIPPED' };
    return processDocument(documentId);
  }

  return { accept, processDocument, reprocessStale, retryFailed };
}

export type IngestionService = ReturnType<typeof createIngestionService>;
