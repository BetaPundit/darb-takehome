import { rematchForTransactions } from '@/lib/services/rematch';
import { isUniqueViolation } from '@/lib/services/match-pipeline';
import type { WebhookDeps } from '@/lib/webhooks/deps';
import { verifySignature } from '@/lib/webhooks/hmac';
import { accepted, readRawBody, tooLarge, unauthorized, unavailable } from '@/lib/webhooks/http';
import { parseJsonBody } from '@/lib/webhooks/route-helpers';
import { transactionFeedSchema } from '@/lib/webhooks/schemas';

/**
 * POST /api/webhooks/transactions: the card-transaction feed. Idempotent on externalRef (the provider's own id).
 * New transactions trigger a re-match of UNMATCHED documents, because receipts often arrive before the card settles.
 */
export async function handleTransactionsWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  const { env, db, log } = deps;

  const body = await readRawBody(req, env.MAX_BODY_BYTES);
  if (!body.ok) return tooLarge();

  const sig = verifySignature({ rawBody: body.raw, header: req.headers.get('x-signature-256'), secret: env.TRANSACTIONS_WEBHOOK_SECRET });
  if (sig === 'invalid') return unauthorized();
  if (sig === 'skipped') log.warn('webhook.signature_check_skipped', { endpoint: 'transactions' });

  const parsed = parseJsonBody(body.raw, transactionFeedSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const known = new Set((await db.client.findMany({ select: { id: true } })).map((c) => c.id));
    const unknown = parsed.value.filter((t) => !known.has(t.clientId)).map((t) => t.externalRef);
    if (unknown.length > 0) {
      return Response.json({ status: 'invalid', issues: unknown.map((ref) => ({ path: ref, message: 'UNKNOWN_CLIENT' })) }, { status: 400 });
    }

    const createdIds: string[] = [];
    let existing = 0;
    for (const t of parsed.value) {
      try {
        const row = await db.transaction.create({
          data: {
            externalRef: t.externalRef,
            clientId: t.clientId,
            driverPhone: t.driverPhone ?? null,
            merchantName: t.merchantName,
            amountMinor: t.amountMinor,
            currency: t.currency,
            occurredAt: new Date(t.occurredAt),
            cardLast4: t.cardLast4 ?? null,
          },
          select: { id: true },
        });
        createdIds.push(row.id);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        existing++; // redelivery of a transaction we already hold: first write wins, never overwritten
      }
    }

    if (createdIds.length > 0) deps.schedule(() => rematchForTransactions(db, createdIds, deps.now(), log).then(() => undefined));
    return accepted({ created: createdIds.length, existing });
  } catch (err) {
    log.error('webhook.transactions_unavailable', { error: err instanceof Error ? err.name : 'unknown' });
    return unavailable(30);
  }
}
