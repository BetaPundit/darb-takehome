import { z } from 'zod';
import { constantTimeEqual } from '@/lib/webhooks/hmac';

/* ------------------------------------------------------------------ phone */

/**
 * Normalise to E.164. Mirrors the rules of lib/matching/normalize.ts `normalizePhone`
 * (kept local on purpose so this module does not depend on the matcher).
 * KSA: '9665...', '+9665...', '05...' (and bare '5...'). Returns null for garbage.
 */
export function toE164(raw: string): string | null {
  const cleaned = raw.trim().replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(cleaned)) return null;

  const hasPlus = cleaned.startsWith('+');
  let digits = hasPlus ? cleaned.slice(1) : cleaned;
  if (!hasPlus) {
    if (digits.startsWith('00')) digits = digits.slice(2);
    else if (digits.length === 10 && digits.startsWith('05')) digits = `966${digits.slice(1)}`;
    else if (digits.length === 9 && digits.startsWith('5')) digits = `966${digits}`;
  }
  if (digits.startsWith('0')) return null;
  if (digits.startsWith('966') && digits.length !== 12) return null;
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

/* ------------------------------------------------------------------ email */

export const ALLOWED_ATTACHMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;

/**
 * `filename` is untrusted display metadata only. It is NEVER used to build a filesystem path
 * (blobs are stored under their sha256). We still strip separators and control chars so it is
 * safe to log, show in the UI, or pass to an extractor as a hint.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(CONTROL_CHARS, '').replace(/[\\/]/g, '_').trim();
  return cleaned.length > 0 ? cleaned : 'attachment';
}

const attachmentSchema = z.object({
  filename: z.string().min(1).max(255).transform(sanitizeFilename),
  contentType: z.enum(ALLOWED_ATTACHMENT_TYPES),
  contentBase64: z.string(),
});

export const emailWebhookSchema = z.object({
  messageId: z.string().trim().min(1).max(255),
  from: z.string().email().transform((s) => s.toLowerCase()),
  // The assignment's sample has a single address as a string; providers that list recipients send an array.
  // Normalised to a list so nothing downstream sees two shapes. Nothing reads it yet; it is validated, not trusted.
  to: z.preprocess((v) => (typeof v === 'string' ? [v] : v), z.array(z.string().email()).min(1)),
  subject: z.string().max(1000).optional(),
  receivedAt: z.string().datetime({ offset: true }).optional(),
  attachments: z.array(attachmentSchema).min(1).max(10),
});
export type EmailWebhook = z.infer<typeof emailWebhookSchema>;

export type DecodeResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: 'TOO_LARGE' | 'INVALID_BASE64' | 'EMPTY' };

// Linear scan, no nested quantifiers (no ReDoS); padding is only legal at the end.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The decoded size is computed from the string LENGTH before any Buffer is allocated, so an
 * oversized attachment cannot make us allocate. Strict standard base64 (no whitespace, no URL-safe
 * alphabet): Buffer.from(s, 'base64') silently skips garbage, so it cannot be used to validate.
 */
export function decodeAttachment(att: { contentBase64: string }, maxBytes: number): DecodeResult {
  const s = att.contentBase64;
  if (s.length === 0) return { ok: false, reason: 'EMPTY' };

  const padding = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const estimatedBytes = Math.floor((s.length * 3) / 4) - padding;
  if (estimatedBytes > maxBytes) return { ok: false, reason: 'TOO_LARGE' };

  if (s.length % 4 !== 0 || !BASE64_RE.test(s)) return { ok: false, reason: 'INVALID_BASE64' };

  const bytes = Buffer.from(s, 'base64');
  if (bytes.length === 0) return { ok: false, reason: 'EMPTY' };
  return { ok: true, bytes };
}

/* --------------------------------------------------------------- whatsapp */

const messageBase = { id: z.string().min(1), from: z.string().min(1), timestamp: z.string().optional() };

const imageMessageSchema = z.object({
  ...messageBase,
  type: z.literal('image'),
  image: z.object({
    id: z.string().min(1),
    mime_type: z.string().min(1),
    sha256: z.string().optional(),
    caption: z.string().optional(),
  }),
});

const documentMessageSchema = z.object({
  ...messageBase,
  type: z.literal('document'),
  document: z.object({
    id: z.string().min(1),
    mime_type: z.string().min(1),
    filename: z.string().optional(),
    sha256: z.string().optional(),
    caption: z.string().optional(),
  }),
});

// Any other type (text, audio, sticker, ...) is ignorable. 'image'/'document' are excluded so a
// MALFORMED image/document message fails validation (400) instead of being silently dropped here.
const otherMessageSchema = z.object({
  ...messageBase,
  type: z.string().refine((t) => t !== 'image' && t !== 'document'),
});

const messageSchema = z.union([imageMessageSchema, documentMessageSchema, otherMessageSchema]);

// The envelope extras (object, entry.id, field, messaging_product, metadata) are optional because the assignment's own
// sample payload has none of them; Meta's real deliveries always do. What IS present is still validated (object must be
// 'whatsapp_business_account', the rest must be strings), and the message shapes below are unchanged and strict.
// Unknown keys are ignored (zod strips them).
export const whatsappWebhookSchema = z.object({
  object: z.literal('whatsapp_business_account').optional(),
  entry: z.array(
    z.object({
      id: z.string().optional(),
      changes: z.array(
        z.object({
          field: z.string().optional(),
          value: z.object({
            messaging_product: z.string().optional(),
            metadata: z.object({ phone_number_id: z.string() }).passthrough().optional(),
            messages: z.array(messageSchema).optional(),
            statuses: z.array(z.unknown()).optional(),
          }),
        }),
      ),
    }),
  ),
});
export type WhatsAppWebhook = z.infer<typeof whatsappWebhookSchema>;

export interface MediaMessage {
  messageId: string;
  fromPhone: string;
  mediaId: string;
  mimeType: string;
  fileName?: string;
}

/** Flattens the envelope to image/document messages; drops everything else and messages with an unusable phone. */
export function extractMediaMessages(parsed: WhatsAppWebhook): MediaMessage[] {
  const out: MediaMessage[] = [];
  for (const entry of parsed.entry) {
    for (const change of entry.changes) {
      for (const msg of change.value.messages ?? []) {
        if (msg.type !== 'image' && msg.type !== 'document') continue;
        const fromPhone = toE164(msg.from);
        if (fromPhone === null) continue;
        if ('image' in msg) {
          out.push({ messageId: msg.id, fromPhone, mediaId: msg.image.id, mimeType: msg.image.mime_type });
        } else if ('document' in msg) {
          const { id, mime_type, filename } = msg.document;
          out.push({
            messageId: msg.id,
            fromPhone,
            mediaId: id,
            mimeType: mime_type,
            ...(filename !== undefined && { fileName: filename }),
          });
        }
      }
    }
  }
  return out;
}

export const whatsappVerifyQuerySchema = z.object({
  'hub.mode': z.string(),
  'hub.verify_token': z.string(),
  // Echoed back verbatim, so restrict the charset (Meta sends an integer).
  'hub.challenge': z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
});

export function checkWhatsAppVerify(
  query: unknown,
  expectedToken: string | undefined,
): { ok: true; challenge: string } | { ok: false } {
  if (!expectedToken) return { ok: false };
  const parsed = whatsappVerifyQuerySchema.safeParse(query);
  if (!parsed.success) return { ok: false };
  const q = parsed.data;
  if (q['hub.mode'] !== 'subscribe' || !constantTimeEqual(q['hub.verify_token'], expectedToken)) {
    return { ok: false };
  }
  return { ok: true, challenge: q['hub.challenge'] };
}

/* ----------------------------------------------------------- transactions */

// Prisma `Int` is a 32-bit signed integer; larger values would surface as a DB error (500).
const MAX_INT32 = 2_147_483_647;

export const transactionFeedSchema = z
  .array(
    z.object({
      externalRef: z.string().trim().min(1).max(255),
      clientId: z.string().min(1).max(255),
      driverPhone: z
        .string()
        .nullish()
        .transform((raw, ctx) => {
          if (raw === null || raw === undefined) return raw;
          const phone = toE164(raw);
          if (phone === null) {
            ctx.addIssue({ code: 'custom', message: 'Invalid phone number' });
            return z.NEVER;
          }
          return phone;
        }),
      merchantName: z.string().trim().min(1).max(255),
      amountMinor: z.number().int().min(0).max(MAX_INT32),
      currency: z.string().regex(/^[A-Z]{3}$/).default('SAR'),
      occurredAt: z.string().datetime({ offset: true }),
      cardLast4: z.string().regex(/^\d{4}$/).nullish(),
    }),
  )
  .min(1)
  .max(500);
export type TransactionFeed = z.infer<typeof transactionFeedSchema>;
