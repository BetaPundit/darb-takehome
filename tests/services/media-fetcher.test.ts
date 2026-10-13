import {
  ALLOWED_MEDIA_HOST_SUFFIXES,
  MediaFetchError,
  WhatsAppMediaFetcher,
  type MediaFetchErrorCode,
} from '@/lib/services/media-fetcher';

const TOKEN = 'EAAG-secret-token';
const GRAPH = 'https://graph.facebook.com/v21.0';
const CDN = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1&ext=2&hash=3';

type Call = { url: string; init: RequestInit | undefined };
type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function fakeFetch(handlers: Handler[]): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const h = handlers[calls.length - 1];
    if (!h) throw new Error(`unexpected fetch #${calls.length}: ${url}`);
    return h(url, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const metaOk = (over: Record<string, unknown> = {}): Handler => () =>
  Response.json({ url: CDN, mime_type: 'image/jpeg', file_size: 3, ...over });
const bytesOk = (body: BodyInit = Buffer.from([1, 2, 3])): Handler => () => new Response(body, { status: 200 });

function make(handlers: Handler[], opts: { maxBytes?: number; timeoutMs?: number } = {}) {
  const { fetchImpl, calls } = fakeFetch(handlers);
  const fetcher = new WhatsAppMediaFetcher({ accessToken: TOKEN, fetchImpl, maxBytes: 1000, ...opts });
  return { fetcher, calls };
}

async function failure(p: Promise<unknown>): Promise<MediaFetchError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(MediaFetchError);
    return e as MediaFetchError;
  }
  throw new Error('expected rejection');
}

function expectError(e: MediaFetchError, code: MediaFetchErrorCode, retryable: boolean) {
  expect({ code: e.code, retryable: e.retryable }).toEqual({ code, retryable });
  // Neither the token nor the signed CDN URL may leak into messages that get logged.
  expect(e.message).not.toContain(TOKEN);
  expect(e.message).not.toContain('hash=3');
}

describe('WhatsAppMediaFetcher happy path', () => {
  it('does the two-step flow with the bearer token on both calls', async () => {
    const { fetcher, calls } = make([metaOk(), bytesOk()]);
    const r = await fetcher.download('1234567890');
    expect(r.bytes.equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(r.mimeType).toBe('image/jpeg');
    expect(calls.map((c) => c.url)).toEqual([`${GRAPH}/1234567890`, CDN]);
    for (const c of calls) {
      expect((c.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      expect(c.init?.redirect).toBe('manual');
      expect(c.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('honours a custom graphBase (trailing slash tolerated)', async () => {
    const { fetchImpl, calls } = fakeFetch([metaOk(), bytesOk()]);
    const f = new WhatsAppMediaFetcher({ accessToken: TOKEN, fetchImpl, maxBytes: 10, graphBase: 'https://graph.facebook.com/v99.0/' });
    await f.download('1');
    expect(calls[0]?.url).toBe('https://graph.facebook.com/v99.0/1');
  });
});

describe('mediaId validation (no path injection)', () => {
  it.each(['', 'abc', '../me', '123/../456', '123?x=1', '123 ', '1'.repeat(33), '١٢٣', '12.3', '-1'])(
    'rejects %p before any request',
    async (id) => {
      const { fetcher, calls } = make([]);
      expectError(await failure(fetcher.download(id)), 'INVALID_MEDIA_ID', false);
      expect(calls).toHaveLength(0);
    },
  );
});

describe('media URL allowlist (no SSRF, no token leak)', () => {
  it.each([
    ['http scheme', 'http://lookaside.fbsbx.com/x'],
    ['unlisted host', 'https://evil.example.com/x'],
    ['suffix lookalike', 'https://evilfbcdn.net/x'],
    ['allowlisted name as subdomain of attacker', 'https://graph.facebook.com.evil.com/x'],
    ['userinfo trick', 'https://graph.facebook.com@evil.com/x'],
    ['loopback', 'https://127.0.0.1/x'],
    ['cloud metadata', 'https://169.254.169.254/latest/meta-data'],
    ['localhost', 'https://localhost/x'],
    ['non-default port', 'https://lookaside.fbsbx.com:8443/x'],
    ['file scheme', 'file:///etc/passwd'],
    ['not a url', 'not a url'],
    ['relative', '/v21.0/123'],
    ['trailing-dot host', 'https://fbcdn.net./x'],
  ])('refuses %s and never sends the token to it', async (_n, url) => {
    const { fetcher, calls } = make([metaOk({ url })]);
    expectError(await failure(fetcher.download('1')), 'DISALLOWED_URL', false);
    expect(calls).toHaveLength(1); // only the Graph metadata call happened
  });

  it.each([
    'https://lookaside.fbsbx.com/a',
    'https://scontent.xx.fbcdn.net/a',
    'https://fbcdn.net/a',
    'https://mmg.whatsapp.net/a',
    'https://graph.facebook.com/a',
    'https://LOOKASIDE.FBSBX.COM/a',
  ])('allows %s', async (url) => {
    const { fetcher } = make([metaOk({ url }), bytesOk()]);
    await expect(fetcher.download('1')).resolves.toBeDefined();
  });

  it('exports the allowlist', () => {
    expect([...ALLOWED_MEDIA_HOST_SUFFIXES]).toEqual(['graph.facebook.com', 'fbcdn.net', 'lookaside.fbsbx.com', 'whatsapp.net']);
  });

  it('does not follow redirects: a 302 from the CDN is a permanent failure, not a second request', async () => {
    const { fetcher, calls } = make([
      metaOk(),
      () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
    ]);
    expectError(await failure(fetcher.download('1')), 'HTTP_ERROR', false);
    expect(calls).toHaveLength(2);
  });
});

describe('size limits', () => {
  it('rejects early when metadata file_size exceeds the cap (no CDN request)', async () => {
    const { fetcher, calls } = make([metaOk({ file_size: 5000 })], { maxBytes: 1000 });
    expectError(await failure(fetcher.download('1')), 'TOO_LARGE', false);
    expect(calls).toHaveLength(1);
  });

  it('rejects on a Content-Length over the cap', async () => {
    const { fetcher } = make(
      [metaOk({ file_size: 1 }), () => new Response('x', { headers: { 'content-length': '5000' } })],
      { maxBytes: 1000 },
    );
    expectError(await failure(fetcher.download('1')), 'TOO_LARGE', false);
  });

  it('enforces the cap on streamed bytes when file_size and Content-Length lie, and stops reading', async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        c.enqueue(new Uint8Array(400));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { fetcher } = make([metaOk({ file_size: 1 }), () => new Response(body, { headers: { 'content-length': '1' } })], {
      maxBytes: 1000,
    });
    expectError(await failure(fetcher.download('1')), 'TOO_LARGE', false);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(10);
  });

  it('accepts exactly maxBytes', async () => {
    const { fetcher } = make([metaOk({ file_size: 10 }), bytesOk(Buffer.alloc(10, 7))], { maxBytes: 10 });
    expect((await fetcher.download('1')).bytes).toHaveLength(10);
  });
});

describe('error classification', () => {
  it.each([500, 502, 503, 429])('metadata HTTP %i is retryable', async (status) => {
    const { fetcher } = make([() => new Response('{}', { status })]);
    const e = await failure(fetcher.download('1'));
    expectError(e, 'HTTP_ERROR', true);
    expect(e.status).toBe(status);
  });

  it.each([400, 401, 403, 404])('metadata HTTP %i is permanent', async (status) => {
    const { fetcher } = make([() => new Response('{}', { status })]);
    const e = await failure(fetcher.download('1'));
    expectError(e, 'HTTP_ERROR', false);
    expect(e.status).toBe(status);
  });

  it.each([
    [503, true],
    [404, false],
    [410, false],
  ])('CDN HTTP %i retryable=%s', async (status, retryable) => {
    const { fetcher } = make([metaOk(), () => new Response('x', { status })]);
    expectError(await failure(fetcher.download('1')), 'HTTP_ERROR', retryable);
  });

  it('network errors (both steps) are retryable', async () => {
    const boom = () => {
      throw new TypeError('fetch failed: ECONNRESET');
    };
    expectError(await failure(make([boom]).fetcher.download('1')), 'NETWORK', true);
    expectError(await failure(make([metaOk(), boom]).fetcher.download('1')), 'NETWORK', true);
  });

  it('a body stream error mid-download is retryable', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(new Error('socket hang up'));
      },
    });
    expectError(await failure(make([metaOk(), () => new Response(body)]).fetcher.download('1')), 'NETWORK', true);
  });

  it.each([
    ['not JSON', () => new Response('<html>', { status: 200 })],
    ['missing url', () => Response.json({ mime_type: 'image/png' })],
    ['missing mime_type', () => Response.json({ url: CDN })],
    ['url wrong type', () => Response.json({ url: 123, mime_type: 'image/png' })],
  ])('malformed metadata (%s) is permanent', async (_n, h) => {
    expectError(await failure(make([h]).fetcher.download('1')), 'BAD_RESPONSE', false);
  });

  it('an empty media body is permanent', async () => {
    expectError(await failure(make([metaOk(), () => new Response(null)]).fetcher.download('1')), 'BAD_RESPONSE', false);
  });
});

describe('timeout', () => {
  const hang: Handler = (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });

  it('aborts a hanging metadata request and is retryable', async () => {
    const { fetcher } = make([hang], { timeoutMs: 20 });
    expectError(await failure(fetcher.download('1')), 'TIMEOUT', true);
  });

  it('aborts a hanging CDN request and is retryable', async () => {
    const { fetcher } = make([metaOk(), hang], { timeoutMs: 20 });
    expectError(await failure(fetcher.download('1')), 'TIMEOUT', true);
  });

  it('aborts a slow-drip body (the deadline covers streaming)', async () => {
    const slow: Handler = (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        pull: (c) =>
          new Promise<void>((resolve, reject) => {
            const t = setTimeout(() => {
              c.enqueue(new Uint8Array(1));
              resolve();
            }, 10);
            init?.signal?.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      });
      return new Response(body);
    };
    const { fetcher } = make([metaOk({ file_size: 1 }), slow], { timeoutMs: 50, maxBytes: 100000 });
    expectError(await failure(fetcher.download('1')), 'TIMEOUT', true);
  });
});
