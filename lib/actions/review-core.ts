import { Prisma, type PrismaClient } from '@/lib/generated/prisma/client';
import { consoleLogger, type Logger } from '@/lib/logger';
import { isUniqueViolation } from '@/lib/services/match-pipeline';

/**
 * Reviewer decisions. Plain functions over a PrismaClient so they run (and are tested) without the Next
 * runtime. The next-safe-action wrappers live in review.ts; they cannot live in the same file because a
 * 'use server' module turns every export into a callable endpoint, and these take a db handle.
 */

const MESSAGES = {
  MATCH_NOT_FOUND: 'This match no longer exists',
  TRANSACTION_ALREADY_CONFIRMED: 'This transaction was already matched to another document',
  MATCH_ALREADY_REJECTED: 'This candidate was already rejected',
  MATCH_ALREADY_CONFIRMED: 'This match is already confirmed and cannot be rejected',
  SCOPE_MISMATCH: 'This document is not allowed to match this transaction',
} as const;

export type ReviewErrorCode = keyof typeof MESSAGES;

export class ReviewError extends Error {
  constructor(readonly code: ReviewErrorCode) {
    super(MESSAGES[code]);
    this.name = 'ReviewError';
  }
}

export type ClientError = { code: ReviewErrorCode | 'INTERNAL'; message: string };

/** What the client may see. Typed errors pass through; everything else is logged here and replaced by a generic message. */
export function toClientError(err: Error, log: Logger = consoleLogger): ClientError {
  if (err instanceof ReviewError) return { code: err.code, message: err.message };
  log.error('review.action_failed', { error: err.name, message: err.message });
  return { code: 'INTERNAL', message: 'Something went wrong. Please try again.' };
}

const TXN_TAKEN = 'system:txn-taken';
const CONFIRMED = ['AUTO_CONFIRMED', 'CONFIRMED'] as const;

export interface ConfirmResult {
  matchId: string;
  documentId: string;
  transactionId: string;
  alreadyConfirmed: boolean;
}

export async function confirmMatchCore(db: PrismaClient, matchId: string): Promise<ConfirmResult> {
  try {
    return await db.$transaction((tx) => confirmInTransaction(tx, matchId));
  } catch (err) {
    // Lost the race at the partial unique index (another reviewer or an auto-confirm took the transaction
    // between our check and our write). Caught here, outside the callback: after a failed statement
    // Postgres aborts the whole transaction, so nothing more can run inside it. The rollback already happened.
    if (isUniqueViolation(err)) throw new ReviewError('TRANSACTION_ALREADY_CONFIRMED');
    throw err;
  }
}

async function confirmInTransaction(tx: Prisma.TransactionClient, matchId: string): Promise<ConfirmResult> {
  const match = await tx.documentMatch.findUnique({ where: { id: matchId }, include: { document: true, transaction: true } });
  if (!match) throw new ReviewError('MATCH_NOT_FOUND');
  const { document, transaction } = match;
  const result = { matchId, documentId: document.id, transactionId: transaction.id };

  if (match.status === 'CONFIRMED' || match.status === 'AUTO_CONFIRMED') return { ...result, alreadyConfirmed: true };
  // A candidate the winner of a race rejected for us reads as "taken", not "you rejected it".
  if (match.status === 'REJECTED') throw new ReviewError(match.decidedBy === TXN_TAKEN ? 'TRANSACTION_ALREADY_CONFIRMED' : 'MATCH_ALREADY_REJECTED');

  // The matcher already scopes candidates; this stops a forged or corrupt match row from crossing tenants.
  const owns = document.source === 'EMAIL' ? document.clientId === transaction.clientId : document.senderRef === transaction.driverPhone;
  if (!owns) throw new ReviewError('SCOPE_MISMATCH');

  const taken = await tx.documentMatch.findFirst({ where: { transactionId: transaction.id, status: { in: [...CONFIRMED] }, id: { not: matchId } }, select: { id: true } });
  if (taken) throw new ReviewError('TRANSACTION_ALREADY_CONFIRMED');

  const now = new Date();
  // Guarded on CANDIDATE; the unique index is what really arbitrates two writers (see confirmMatchCore).
  const confirmed = await tx.documentMatch.updateMany({ where: { id: matchId, status: 'CANDIDATE' }, data: { status: 'CONFIRMED', decidedBy: 'reviewer', decidedAt: now } });
  if (confirmed.count !== 1) throw new Error(`Match ${matchId} changed state while being confirmed`);

  await tx.documentMatch.updateMany({
    where: { documentId: document.id, status: 'CANDIDATE', id: { not: matchId } },
    data: { status: 'REJECTED', decidedBy: 'system:sibling-confirmed', decidedAt: now },
  });

  // Other documents were offered this same transaction. Reject those offers, and never leave such a
  // document in NEEDS_REVIEW with nothing to review: it goes back to UNMATCHED (re-match may pick it up later).
  const competing = await tx.documentMatch.findMany({
    where: { transactionId: transaction.id, status: 'CANDIDATE', documentId: { not: document.id } },
    select: { id: true, documentId: true },
  });
  if (competing.length > 0) {
    await tx.documentMatch.updateMany({
      where: { id: { in: competing.map((m) => m.id) }, status: 'CANDIDATE' },
      data: { status: 'REJECTED', decidedBy: TXN_TAKEN, decidedAt: now },
    });
    for (const documentId of new Set(competing.map((m) => m.documentId))) {
      await unmatchIfNoCandidates(tx, documentId, 'CANDIDATE_TAKEN');
    }
  }

  const matched = await tx.document.updateMany({
    where: { id: document.id, status: { in: ['NEEDS_REVIEW', 'UNMATCHED'] } },
    data: { status: 'MATCHED' },
  });
  if (matched.count !== 1) throw new Error(`Document ${document.id} is ${document.status}, expected NEEDS_REVIEW or UNMATCHED`);

  return { ...result, alreadyConfirmed: false };
}

/** A NEEDS_REVIEW document whose last candidate is gone becomes UNMATCHED. Documents in any other state are left alone. */
async function unmatchIfNoCandidates(tx: Prisma.TransactionClient, documentId: string, matchReason: string): Promise<void> {
  const remaining = await tx.documentMatch.count({ where: { documentId, status: 'CANDIDATE' } });
  if (remaining > 0) return;
  await tx.document.updateMany({ where: { id: documentId, status: 'NEEDS_REVIEW' }, data: { status: 'UNMATCHED', matchReason } });
}

export interface RejectResult {
  matchId: string;
  documentStatus: string;
}

export async function rejectMatchCore(db: PrismaClient, matchId: string): Promise<RejectResult> {
  return db.$transaction(async (tx) => {
    const match = await tx.documentMatch.findUnique({ where: { id: matchId }, select: { status: true, documentId: true } });
    if (!match) throw new ReviewError('MATCH_NOT_FOUND');
    if (match.status === 'CONFIRMED' || match.status === 'AUTO_CONFIRMED') throw new ReviewError('MATCH_ALREADY_CONFIRMED');

    if (match.status === 'CANDIDATE') {
      const rejected = await tx.documentMatch.updateMany({ where: { id: matchId, status: 'CANDIDATE' }, data: { status: 'REJECTED', decidedBy: 'reviewer', decidedAt: new Date() } });
      if (rejected.count !== 1) throw new Error(`Match ${matchId} changed state while being rejected`);
      await unmatchIfNoCandidates(tx, match.documentId, 'ALL_CANDIDATES_REJECTED');
    }
    const document = await tx.document.findUniqueOrThrow({ where: { id: match.documentId }, select: { status: true } });
    return { matchId, documentStatus: document.status };
  });
}
