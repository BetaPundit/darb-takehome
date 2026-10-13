import type { WebhookDeps } from '@/lib/webhooks/deps';
import { verifySignature } from '@/lib/webhooks/hmac';
import { accepted, ignored, readRawBody, tooLarge, unauthorized, unavailable } from '@/lib/webhooks/http';
import { parseJsonBody } from '@/lib/webhooks/route-helpers';
import { decodeAttachment, emailWebhookSchema } from '@/lib/webhooks/schemas';


/**
 * POST /api/webhooks/email
 * Order matters: cap size -> verify signature -> validate -> authorise sender -> decode -> store -> respond.
 * Anything slow (OCR, matching) happens after the response, via deps.schedule.
 */
export async function handleEmailWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  const { env, db, ingestion, log } = deps;

  const body = await readRawBody(req, env.MAX_BODY_BYTES);
  if (!body.ok) return tooLarge();

  // HMAC is over the exact bytes received, before anything is parsed.
  const sig = verifySignature({ rawBody: body.raw, header: req.headers.get('x-signature-256'), secret: env.EMAIL_WEBHOOK_SECRET });
  if (sig === 'invalid') return unauthorized();
  if (sig === 'skipped') log.warn('webhook.signature_check_skipped', { endpoint: 'email' });

  const parsed = parseJsonBody(body.raw, emailWebhookSchema);
  if (!parsed.ok) return parsed.response;
  const email = parsed.value;

  try {
    // Only registered client mailboxes may submit. Unknown senders are acknowledged and NOT stored
    // (nothing to scope them to, and storing them would let anyone fill the disk).
    const sender = await db.clientSender.findUnique({ where: { email: email.from }, select: { clientId: true } });
    if (!sender) {
      log.info('webhook.email_unknown_sender', {});
      return ignored('UNKNOWN_SENDER');
    }

    const attachments = [];
    for (const [i, att] of email.attachments.entries()) {
      const decoded = decodeAttachment(att, env.MAX_BODY_BYTES);
      if (!decoded.ok) {
        if (decoded.reason === 'TOO_LARGE') return tooLarge();
        return Response.json({ status: 'invalid', issues: [{ path: `attachments.${i}.contentBase64`, message: decoded.reason }] }, { status: 400 });
      }
      attachments.push({ fileName: att.filename, mimeType: att.contentType, bytes: decoded.bytes });
    }

    const results = await ingestion.accept({
      source: 'EMAIL',
      externalMessageId: email.messageId,
      scope: { kind: 'EMAIL', clientId: sender.clientId, email: email.from },
      attachments,
    });
    for (const r of results.filter((x) => !x.duplicate)) deps.schedule(() => ingestion.processDocument(r.documentId).then(() => undefined));

    return accepted({ documents: results });
  } catch (err) {
    // Infrastructure failure BEFORE anything was durably accepted: tell the sender to retry. Idempotency makes that safe.
    log.error('webhook.email_unavailable', { error: err instanceof Error ? err.name : 'unknown' });
    return unavailable(30);
  }
}
