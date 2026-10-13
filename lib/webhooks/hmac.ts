import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type SignatureResult = 'valid' | 'invalid' | 'skipped';

const HEADER_RE = /^sha256=([0-9a-fA-F]{64})$/;

function mac(rawBody: Buffer | string, secret: string): Buffer {
  return createHmac('sha256', secret).update(rawBody).digest();
}

/** `sha256=<hex>`: the Meta X-Hub-Signature-256 format, reused for our email and transaction feeds. */
export function signPayload(rawBody: Buffer | string, secret: string): string {
  return `sha256=${mac(rawBody, secret).toString('hex')}`;
}

/**
 * Verifies HMAC-SHA256 over the EXACT bytes received. Never pass re-serialized JSON.
 * 'skipped' means no secret is configured; the caller decides whether that is acceptable (env.ts forbids it in production).
 */
export function verifySignature(args: {
  rawBody: Buffer | string;
  header: string | null;
  secret: string | undefined;
}): SignatureResult {
  const { rawBody, header, secret } = args;
  if (!secret) return 'skipped';

  const match = header === null ? null : HEADER_RE.exec(header);
  if (!match?.[1]) return 'invalid';

  const provided = Buffer.from(match[1], 'hex'); // regex guarantees 32 bytes
  const expected = mac(rawBody, secret);
  // timingSafeEqual throws on unequal lengths; the regex makes this unreachable, kept as a guard.
  if (provided.length !== expected.length) return 'invalid';
  return timingSafeEqual(provided, expected) ? 'valid' : 'invalid';
}

/** Constant-time string compare that tolerates different lengths (hashes both sides first). */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
