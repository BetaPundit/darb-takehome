import { MediaFetchError } from '@/lib/services/media-fetcher';
import type { WebhookDeps } from '@/lib/webhooks/deps';
import { verifySignature } from '@/lib/webhooks/hmac';
import { accepted, ignored, readRawBody, tooLarge, unauthorized, unavailable } from '@/lib/webhooks/http';
import { parseJsonBody } from '@/lib/webhooks/route-helpers';
import { ALLOWED_ATTACHMENT_TYPES, checkWhatsAppVerify, extractMediaMessages, whatsappWebhookSchema } from '@/lib/webhooks/schemas';

/** GET /api/webhooks/whatsapp: Meta's subscription handshake. Echoes hub.challenge only if the verify token matches. */
export function handleWhatsAppVerify(req: Request, deps: WebhookDeps): Response {
  const query = Object.fromEntries(new URL(req.url).searchParams);
  const result = checkWhatsAppVerify(query, deps.env.WHATSAPP_VERIFY_TOKEN);
  if (!result.ok) return new Response('Forbidden', { status: 403 });
  return new Response(result.challenge, { status: 200, headers: { 'content-type': 'text/plain' } });
}

const isAllowedType = (mime: string) => (ALLOWED_ATTACHMENT_TYPES as readonly string[]).includes(mime);

/**
 * POST /api/webhooks/whatsapp
 * A 200 tells Meta "done, do not redeliver", so we only send it when every media message in the payload is either
 * durably accepted or deliberately skipped. A retryable media failure returns 503 so Meta redelivers: the message
 * ids make redelivery idempotent, so messages already accepted in this payload are not duplicated.
 */
export async function handleWhatsAppWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  const { env, db, ingestion, media, log } = deps;

  const body = await readRawBody(req, env.MAX_BODY_BYTES);
  if (!body.ok) return tooLarge();

  const sig = verifySignature({ rawBody: body.raw, header: req.headers.get('x-hub-signature-256'), secret: env.WHATSAPP_APP_SECRET });
  if (sig === 'invalid') return unauthorized();
  if (sig === 'skipped') log.warn('webhook.signature_check_skipped', { endpoint: 'whatsapp' });

  const parsed = parseJsonBody(body.raw, whatsappWebhookSchema);
  if (!parsed.ok) return parsed.response;

  // Status-only deliveries, text messages, stickers etc. are filtered out here.
  const messages = extractMediaMessages(parsed.value);
  if (messages.length === 0) return ignored('NO_MEDIA');

  let documents = 0;
  let skipped = 0;
  let retryable = false;

  for (const msg of messages) {
    if (!isAllowedType(msg.mimeType)) {
      skipped++;
      continue;
    }
    try {
      // Redelivery of something we already hold: skip the (network, SSRF-exposed) media download entirely.
      const already = await db.document.findFirst({
        where: { source: 'WHATSAPP', externalMessageId: msg.messageId, attachmentIndex: 0 },
        select: { id: true },
      });
      if (already) continue;

      const file = await media.download(msg.mediaId);
      const [result] = await ingestion.accept({
        source: 'WHATSAPP',
        externalMessageId: msg.messageId,
        scope: { kind: 'WHATSAPP', phone: msg.fromPhone },
        attachments: [{ fileName: msg.fileName ?? 'whatsapp-media', mimeType: msg.mimeType, bytes: file.bytes }],
      });
      if (result && !result.duplicate) {
        documents++;
        deps.schedule(() => ingestion.processDocument(result.documentId).then(() => undefined));
      }
    } catch (err) {
      if (err instanceof MediaFetchError) {
        // 401/403 means OUR token is bad/expired: that is our outage, not the sender's problem. Retry so nothing is lost.
        const ourAuthProblem = err.status === 401 || err.status === 403;
        if (err.retryable || ourAuthProblem) {
          retryable = true;
          log.error('webhook.whatsapp_media_retryable', { code: err.code, status: err.status ?? null });
        } else {
          skipped++;
          log.warn('webhook.whatsapp_media_permanent_failure', { code: err.code, status: err.status ?? null });
        }
      } else {
        retryable = true; // DB / blob store trouble
        log.error('webhook.whatsapp_unavailable', { error: err instanceof Error ? err.name : 'unknown' });
      }
    }
  }

  return retryable ? unavailable(30) : accepted({ documents, skipped });
}
