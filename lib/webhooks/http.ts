import type { ZodError, ZodIssue } from 'zod';

export function accepted(body: Record<string, unknown> = {}): Response {
  return Response.json({ status: 'accepted', ...body }, { status: 200 });
}

export function ignored(reason: string): Response {
  return Response.json({ status: 'ignored', reason }, { status: 200 });
}

/**
 * Zod 3 appends the submitted value to enum issues ("... received 'x'"), so that one message is rebuilt
 * from the schema's own options. Every other message built-in to Zod 3 names types or limits, never values.
 */
function safeMessage(issue: ZodIssue): string {
  if (issue.code === 'invalid_enum_value') {
    return `Invalid enum value. Expected ${issue.options.map((o) => `'${String(o)}'`).join(' | ')}`;
  }
  return issue.message;
}

/** Path + message only. Never echoes submitted values or attachment bytes. */
export function invalid(error: ZodError): Response {
  const issues = error.issues.map((i) => ({ path: i.path.join('.'), message: safeMessage(i) }));
  return Response.json({ status: 'invalid', issues }, { status: 400 });
}

export function unauthorized(): Response {
  return Response.json({ status: 'unauthorized' }, { status: 401 });
}

export function tooLarge(): Response {
  return Response.json({ status: 'too_large' }, { status: 413 });
}

export function unavailable(retryAfterSeconds: number): Response {
  return Response.json(
    { status: 'unavailable' },
    { status: 503, headers: { 'Retry-After': String(Math.ceil(retryAfterSeconds)) } },
  );
}

export type RawBodyResult = { ok: true; raw: Buffer } | { ok: false; reason: 'TOO_LARGE' };

/**
 * Reads the exact request bytes (needed for HMAC) under a hard cap. The cap is enforced on the
 * Content-Length header (fast reject) AND on the bytes actually streamed, because the header can
 * be absent (chunked) or lie.
 */
export async function readRawBody(req: Request, maxBytes: number): Promise<RawBodyResult> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: 'TOO_LARGE' };

  if (!req.body) return { ok: true, raw: Buffer.alloc(0) };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: 'TOO_LARGE' };
    }
    chunks.push(value);
  }
  return { ok: true, raw: Buffer.concat(chunks, total) };
}
