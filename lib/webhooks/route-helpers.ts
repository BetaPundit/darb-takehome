import type { ZodType } from 'zod';
import { invalid } from '@/lib/webhooks/http';

/** Parse raw bytes as JSON and validate. Returns either the typed value or a ready 400 response. */
export function parseJsonBody<T>(raw: Buffer, schema: ZodType<T>): { ok: true; value: T } | { ok: false; response: Response } {
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    return {
      ok: false,
      response: Response.json({ status: 'invalid', issues: [{ path: '', message: 'Body is not valid JSON' }] }, { status: 400 }),
    };
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, response: invalid(parsed.error) };
}
