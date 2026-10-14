import { DEFAULT_MATCHER_CONFIG } from '@/lib/config/matching';
import { extractedDocumentSchema } from '@/lib/extraction/types';
import { Prisma, type PrismaClient } from '@/lib/generated/prisma/client';
import { documentDay } from '@/lib/matching/dates';
import { matchDocument, type MatcherCandidate, type MatchResult } from '@/lib/services/transaction-matcher';

/**
 * Shared by first-time processing and re-matching: load in-scope candidates, run the pure matcher,
 * persist the result. Everything that touches the DB for matching lives here so the matcher stays pure.
 */

const DAY_MS = 86_400_000;

/** Which transactions are even worth scoring. The matcher accepts a document dated up to maxLeadDays after the charge. */
export const CANDIDATE_WINDOW = {
  /** transactions up to this many days before the document date */
  beforeDays: 3,
  /** transactions up to this many days after it (late settlement, monthly supplier invoices) */
  afterDays: 14,
  /** when the document has no usable date: look back this far from now */
  fallbackLookbackDays: 30,
  /** hard cap so one noisy scope cannot make a single document expensive */
  maxCandidates: 200,
} as const;

const CONFIRMED = ['AUTO_CONFIRMED', 'CONFIRMED'] as const;

export class ConcurrentModificationError extends Error {
  constructor(documentId: string) {
    super(`Document ${documentId} changed state while it was being matched`);
    this.name = 'ConcurrentModificationError';
  }
}

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** decidedBy value for offers withdrawn because another document took the transaction. */
export const TXN_TAKEN = 'system:txn-taken';

/** A NEEDS_REVIEW document whose last candidate is gone becomes UNMATCHED. Documents in any other state are left alone. */
export async function unmatchIfNoCandidates(tx: Prisma.TransactionClient, documentId: string, matchReason: string): Promise<void> {
  const remaining = await tx.documentMatch.count({ where: { documentId, status: 'CANDIDATE' } });
  if (remaining > 0) return;
  await tx.document.updateMany({ where: { id: documentId, status: 'NEEDS_REVIEW' }, data: { status: 'UNMATCHED', matchReason } });
}

/**
 * A transaction was just confirmed for `winnerDocumentId` (by the matcher OR by a reviewer). Other documents that were
 * still being OFFERED that transaction lose the offer, and never stay in review with nothing left to review.
 * One implementation for both paths, so the review queue can never show a candidate that can only fail.
 */
export async function withdrawCompetingOffers(tx: Prisma.TransactionClient, transactionId: string, winnerDocumentId: string, now: Date): Promise<void> {
  const competing = await tx.documentMatch.findMany({
    where: { transactionId, status: 'CANDIDATE', documentId: { not: winnerDocumentId } },
    select: { id: true, documentId: true },
  });
  if (competing.length === 0) return;
  await tx.documentMatch.updateMany({
    where: { id: { in: competing.map((m) => m.id) }, status: 'CANDIDATE' },
    data: { status: 'REJECTED', decidedBy: TXN_TAKEN, decidedAt: now },
  });
  for (const documentId of new Set(competing.map((m) => m.documentId))) {
    await unmatchIfNoCandidates(tx, documentId, 'CANDIDATE_TAKEN');
  }
}

export function candidateWindow(documentDate: string | null, now: Date): { from: Date; to: Date } {
  const offsetMinutes = DEFAULT_MATCHER_CONFIG.utcOffsetMinutes;
  const day = documentDate === null ? null : documentDay(documentDate, offsetMinutes);
  if (day === null) {
    return { from: new Date(now.getTime() - CANDIDATE_WINDOW.fallbackLookbackDays * DAY_MS), to: new Date(now.getTime() + DAY_MS) };
  }
  // the document date is a Riyadh calendar day: its start in UTC is midnight minus the offset
  const start = day * DAY_MS - offsetMinutes * 60_000;
  return {
    from: new Date(start - CANDIDATE_WINDOW.beforeDays * DAY_MS),
    to: new Date(start + (CANDIDATE_WINDOW.afterDays + 1) * DAY_MS),
  };
}

interface DocumentScope {
  source: 'EMAIL' | 'WHATSAPP';
  clientId: string | null;
  senderRef: string;
}

async function loadCandidates(
  db: PrismaClient,
  doc: DocumentScope,
  documentDate: string | null,
  now: Date,
  excludeTransactionIds: string[],
): Promise<MatcherCandidate[]> {
  const { from, to } = candidateWindow(documentDate, now);
  const rows = await db.transaction.findMany({
    where: {
      // Scope is a hard SQL filter AND re-checked by the matcher (defence in depth).
      ...(doc.source === 'EMAIL' ? { clientId: doc.clientId ?? '' } : { driverPhone: doc.senderRef }),
      occurredAt: { gte: from, lt: to },
      id: { notIn: excludeTransactionIds },
    },
    orderBy: { occurredAt: 'desc' },
    take: CANDIDATE_WINDOW.maxCandidates,
    include: { matches: { where: { status: { in: [...CONFIRMED] } }, select: { id: true }, take: 1 } },
  });
  return rows.map((t) => ({
    id: t.id,
    clientId: t.clientId,
    driverPhone: t.driverPhone,
    merchantName: t.merchantName,
    amountMinor: t.amountMinor,
    currency: t.currency,
    occurredAt: t.occurredAt,
    cardLast4: t.cardLast4,
    alreadyConfirmed: t.matches.length > 0,
  }));
}

async function persistResult(
  db: PrismaClient,
  documentId: string,
  expectedStatus: 'EXTRACTED' | 'UNMATCHED',
  result: MatchResult,
  reasonOverride?: string,
): Promise<void> {
  const rows = result.candidates.map((c, i) => ({
    documentId,
    transactionId: c.transactionId,
    score: c.score,
    rank: i + 1,
    // flat, plain object: this is the shape the review page reads back
    signals: { ...c.signals, flags: c.flags },
  }));
  const autoConfirm = result.outcome === 'AUTO_MATCHED';
  const status = autoConfirm ? 'MATCHED' : result.outcome === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW' : 'UNMATCHED';

  await db.$transaction(async (tx) => {
    // Compare-and-set on the status we expect: if anything else moved the document, abort everything.
    const moved = await tx.document.updateMany({
      where: { id: documentId, status: expectedStatus },
      data: { status, matchReason: reasonOverride ?? result.reason, processingStartedAt: null },
    });
    if (moved.count !== 1) throw new ConcurrentModificationError(documentId);

    if (rows.length === 0) return;
    const decidedAt = new Date();
    await tx.documentMatch.createMany({
      data: rows.map((r, i) => {
        if (!autoConfirm) return { ...r, status: 'CANDIDATE' as const };
        // Winner is auto-confirmed (the partial unique index decides races). Alternatives are kept for audit.
        return i === 0
          ? { ...r, status: 'AUTO_CONFIRMED' as const, decidedBy: 'system:auto', decidedAt }
          : { ...r, status: 'REJECTED' as const, decidedBy: 'system:auto', decidedAt };
      }),
    });
    if (autoConfirm) await withdrawCompetingOffers(tx, rows[0]!.transactionId, documentId, decidedAt);
  });
}

export interface MatchAndPersistResult {
  outcome: MatchResult['outcome'];
  reason: string;
}

/**
 * Match one document that already has a validated extraction, and persist the outcome.
 * `expectedStatus` is the status the document must still have (EXTRACTED for first processing,
 * UNMATCHED for a re-match): this is what makes concurrent or repeated runs safe.
 */
export async function matchAndPersist(
  db: PrismaClient,
  documentId: string,
  expectedStatus: 'EXTRACTED' | 'UNMATCHED',
  now: Date,
): Promise<MatchAndPersistResult> {
  const doc = await db.document.findUniqueOrThrow({
    where: { id: documentId },
    include: { matches: { where: { status: 'REJECTED' }, select: { transactionId: true } } },
  });
  const extraction = extractedDocumentSchema.parse(doc.extraction);
  const sender =
    doc.source === 'EMAIL'
      ? ({ kind: 'EMAIL', clientId: doc.clientId ?? '' } as const)
      : ({ kind: 'WHATSAPP', phone: doc.senderRef } as const);
  // A reviewer already said "not this one": never offer that pair again (also keeps unique(documentId, transactionId) safe).
  const rejected = doc.matches.map((m) => m.transactionId);

  // Two attempts normally; a lost auto-confirm race means someone confirmed our winner a moment ago,
  // so we re-load (the winner now shows as confirmed and is excluded) and decide again. The final
  // attempt cannot auto-confirm, so a pathological race degrades to human review instead of failing.
  for (let attempt = 0; attempt < 3; attempt++) {
    const allowAuto = attempt < 2;
    const candidates = await loadCandidates(db, doc, extraction.documentDate, now, rejected);
    const raw = matchDocument({ document: extraction, sender, candidates });
    const result: MatchResult =
      !allowAuto && raw.outcome === 'AUTO_MATCHED' ? { ...raw, outcome: 'NEEDS_REVIEW', reason: 'AMBIGUOUS' } : raw;
    try {
      await persistResult(db, documentId, expectedStatus, result, !allowAuto && raw.outcome === 'AUTO_MATCHED' ? 'CONFIRM_RACE_LOST' : undefined);
      return { outcome: result.outcome, reason: result.reason };
    } catch (err) {
      if (!isUniqueViolation(err) || attempt === 2) throw err;
    }
  }
  throw new Error('unreachable');
}
