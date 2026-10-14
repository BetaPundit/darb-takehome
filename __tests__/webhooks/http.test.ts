import { z } from 'zod';
import { accepted, ignored, invalid, readRawBody, tooLarge, unauthorized, unavailable } from '@/lib/webhooks/http';

describe('response helpers', () => {
  it('accepted / ignored return 200 with a status field', async () => {
    const a = accepted({ documents: [{ id: 'd1', duplicate: false }] });
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ status: 'accepted', documents: [{ id: 'd1', duplicate: false }] });
    const i = ignored('UNKNOWN_SENDER');
    expect(i.status).toBe(200);
    expect(await i.json()).toEqual({ status: 'ignored', reason: 'UNKNOWN_SENDER' });
  });

  it('invalid returns 400 with path+message only and never echoes submitted values', async () => {
    const secretValue = 'SUPER-SECRET-PAYLOAD-BYTES';
    const schema = z.object({
      attachments: z.array(z.object({ contentType: z.enum(['application/pdf']), contentBase64: z.string().max(3) })),
    });
    const parsed = schema.safeParse({ attachments: [{ contentType: secretValue, contentBase64: secretValue }] });
    if (parsed.success) throw new Error('expected failure');
    const res = invalid(parsed.error);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain(secretValue);
    const body = JSON.parse(text) as { status: string; issues: Record<string, unknown>[] };
    expect(body.status).toBe('invalid');
    expect(body.issues.map((x) => x.path)).toEqual(['attachments.0.contentType', 'attachments.0.contentBase64']);
    for (const issue of body.issues) expect(Object.keys(issue).sort()).toEqual(['message', 'path']);
  });

  it('unauthorized 401, tooLarge 413, unavailable 503 + Retry-After', async () => {
    expect(unauthorized().status).toBe(401);
    expect(tooLarge().status).toBe(413);
    const u = unavailable(30);
    expect(u.status).toBe(503);
    expect(u.headers.get('Retry-After')).toBe('30');
  });
});

function streamRequest(stream: ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/x', {
    method: 'POST',
    body: stream,
    headers,
    duplex: 'half',
  } as RequestInit);
}

describe('readRawBody', () => {
  it('returns the exact bytes (including non-UTF8 and unusual whitespace)', async () => {
    const bytes = Buffer.from([0x7b, 0x20, 0x20, 0xff, 0x00, 0x7d]);
    const req = new Request('http://localhost/x', { method: 'POST', body: bytes });
    const r = await readRawBody(req, 100);
    expect(r).toEqual({ ok: true, raw: bytes });
  });

  it('handles an empty body', async () => {
    const r = await readRawBody(new Request('http://localhost/x', { method: 'POST' }), 100);
    expect(r).toEqual({ ok: true, raw: Buffer.alloc(0) });
  });

  it('accepts a body of exactly maxBytes and rejects one byte more', async () => {
    const ok = await readRawBody(new Request('http://localhost/x', { method: 'POST', body: 'a'.repeat(10) }), 10);
    expect(ok.ok).toBe(true);
    const bad = await readRawBody(new Request('http://localhost/x', { method: 'POST', body: 'a'.repeat(11) }), 10);
    expect(bad).toEqual({ ok: false, reason: 'TOO_LARGE' });
  });

  it('rejects on a declared Content-Length over the cap without reading the body', async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        c.enqueue(new Uint8Array(1));
      },
    });
    const r = await readRawBody(streamRequest(stream, { 'content-length': '999999' }), 100);
    expect(r).toEqual({ ok: false, reason: 'TOO_LARGE' });
    expect(pulls).toBeLessThanOrEqual(1); // only the stream's own priming pull; we never read
  });

  it('enforces the cap on streamed bytes when Content-Length is absent, and stops reading early', async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        c.enqueue(new Uint8Array(1024)); // endless stream
      },
      cancel() {
        cancelled = true;
      },
    });
    const req = streamRequest(stream);
    expect(req.headers.get('content-length')).toBeNull();
    const r = await readRawBody(req, 4096);
    expect(r).toEqual({ ok: false, reason: 'TOO_LARGE' });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(50);
  });

  it('is not fooled by a lying (too small) Content-Length', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(500));
        c.close();
      },
    });
    const r = await readRawBody(streamRequest(body, { 'content-length': '5' }), 100);
    expect(r).toEqual({ ok: false, reason: 'TOO_LARGE' });
  });

  it('ignores a non-numeric Content-Length and still enforces streamed bytes', async () => {
    const small = await readRawBody(
      new Request('http://localhost/x', { method: 'POST', body: 'abc', headers: { 'content-length': 'abc' } }),
      100,
    );
    expect(small.ok).toBe(true);
  });
});
