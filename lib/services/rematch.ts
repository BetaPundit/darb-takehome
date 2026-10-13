import type { PrismaClient } from '@/lib/generated/prisma/client';
import type { Logger } from '@/lib/logger';
import { ConcurrentModificationError, matchAndPersist } from '@/lib/services/match-pipeline';

/** Only documents received this recently are re-examined: older ones are a human problem, not a matching one. */
export const REMATCH_LOOKBACK_DAYS = 14;
const DAY_MS = 86_400_000;

export interface RematchSummary {
  examined: number;
  autoMatched: number;
  sentToReview: number;
}

/**
 * A transaction arrived after its receipt did (card feeds lag). Give UNMATCHED documents in the same scope another chance.
 * NEEDS_REVIEW documents are left alone: a human may be looking at them, and moving candidates under them would be confusing.
 */
export async function rematchForTransactions(
  db: PrismaClient,
  transactionIds: string[],
  now: Date,
  log: Logger,
): Promise<RematchSummary> {
  const summary: RematchSummary = { examined: 0, autoMatched: 0, sentToReview: 0 };
  if (transactionIds.length === 0) return summary;

  const txns = await db.transaction.findMany({
    where: { id: { in: transactionIds } },
    select: { clientId: true, driverPhone: true },
  });
  const clientIds = [...new Set(txns.map((t) => t.clientId))];
  const phones = [...new Set(txns.flatMap((t) => (t.driverPhone ? [t.driverPhone] : [])))];

  const docs = await db.document.findMany({
    where: {
      status: 'UNMATCHED',
      // A document only becomes UNMATCHED after extraction, so it always has an extraction and a matchReason.
      // INSUFFICIENT_DATA means the extraction was unusable: new transactions cannot fix that.
      matchReason: { not: 'INSUFFICIENT_DATA' },
      receivedAt: { gte: new Date(now.getTime() - REMATCH_LOOKBACK_DAYS * DAY_MS) },
      OR: [
        { source: 'EMAIL', clientId: { in: clientIds } },
        { source: 'WHATSAPP', senderRef: { in: phones } },
      ],
    },
    select: { id: true },
    orderBy: { receivedAt: 'asc' },
  });

  for (const { id } of docs) {
    summary.examined++;
    try {
      const result = await matchAndPersist(db, id, 'UNMATCHED', now);
      if (result.outcome === 'AUTO_MATCHED') summary.autoMatched++;
      if (result.outcome === 'NEEDS_REVIEW') summary.sentToReview++;
    } catch (err) {
      // Someone else moved the document first (e.g. a reviewer): that is fine, skip it.
      if (!(err instanceof ConcurrentModificationError)) throw err;
    }
  }
  log.info('rematch.done', { ...summary, transactions: transactionIds.length });
  return summary;
}
