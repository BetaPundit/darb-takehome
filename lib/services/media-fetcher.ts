import { z } from 'zod';

export interface MediaFetcher {
  download(mediaId: string): Promise<{ bytes: Buffer; mimeType: string }>;
}

export type MediaFetchErrorCode =
  | 'INVALID_MEDIA_ID'
  | 'DISALLOWED_URL'
  | 'TOO_LARGE'
  | 'HTTP_ERROR'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'BAD_RESPONSE';

/** `retryable` true => the route should answer 503 so Meta redelivers; false => log and skip. */
export class MediaFetchError extends Error {
  constructor(
    readonly code: MediaFetchErrorCode,
    readonly retryable: boolean,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MediaFetchError';
  }
}

/** Hosts (and their subdomains) we will ever send the access token to. */
export const ALLOWED_MEDIA_HOST_SUFFIXES = ['graph.facebook.com', 'fbcdn.net', 'lookaside.fbsbx.com', 'whatsapp.net'] as const;

const MEDIA_ID_RE = /^\d{1,32}$/;

const metaMediaSchema = z.object({
  url: z.string(),
  mime_type: z.string().min(1),
  file_size: z.number().optional(),
});

function assertAllowedMediaUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MediaFetchError('DISALLOWED_URL', false, 'Media URL is not a valid URL');
  }
  const host = url.hostname;
  const hostOk = ALLOWED_MEDIA_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
  // https only, default port only, host must be on the allowlist. Checked BEFORE the token is sent.
  if (url.protocol !== 'https:' || url.port !== '' || !hostOk) {
    throw new MediaFetchError('DISALLOWED_URL', false, 'Media URL host or scheme is not allowed');
  }
  return url;
}

function statusError(status: number): MediaFetchError {
  const retryable = status === 429 || status >= 500;
  return new MediaFetchError('HTTP_ERROR', retryable, `Media request failed with HTTP ${status}`, status);
}

export interface WhatsAppMediaFetcherOptions {
  accessToken: string;
  fetchImpl?: typeof fetch;
  graphBase?: string;
  maxBytes: number;
  timeoutMs?: number;
}

export class WhatsAppMediaFetcher implements MediaFetcher {
  private readonly accessToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly graphBase: string;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;

  constructor(opts: WhatsAppMediaFetcherOptions) {
    this.accessToken = opts.accessToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.graphBase = (opts.graphBase ?? 'https://graph.facebook.com/v21.0').replace(/\/+$/, '');
    this.maxBytes = opts.maxBytes;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async download(mediaId: string): Promise<{ bytes: Buffer; mimeType: string }> {
    if (!MEDIA_ID_RE.test(mediaId)) {
      throw new MediaFetchError('INVALID_MEDIA_ID', false, 'Media id must be 1-32 digits');
    }

    // One deadline for the whole download (both requests and the body stream), which also bounds slow-drip bodies.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const meta = await this.fetchMeta(mediaId, controller.signal);
      if (meta.file_size !== undefined && meta.file_size > this.maxBytes) {
        throw new MediaFetchError('TOO_LARGE', false, 'Media exceeds the size limit');
      }
      const url = assertAllowedMediaUrl(meta.url);
      const bytes = await this.fetchBytes(url, controller.signal);
      return { bytes, mimeType: meta.mime_type };
    } catch (err) {
      throw this.classify(err, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  private get(url: string, signal: AbortSignal): Promise<Response> {
    // redirect: 'manual' so a 3xx can never carry the token (or us) to a host we did not vet.
    return this.fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.accessToken}` },
      redirect: 'manual',
      signal,
    });
  }

  private async fetchMeta(mediaId: string, signal: AbortSignal): Promise<z.infer<typeof metaMediaSchema>> {
    const res = await this.get(`${this.graphBase}/${mediaId}`, signal);
    if (!res.ok) throw statusError(res.status);
    const text = await res.text(); // abort / socket errors propagate and are classified as retryable
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new MediaFetchError('BAD_RESPONSE', false, 'Media metadata is not JSON');
    }
    const parsed = metaMediaSchema.safeParse(json);
    if (!parsed.success) throw new MediaFetchError('BAD_RESPONSE', false, 'Unexpected media metadata response');
    return parsed.data;
  }

  private async fetchBytes(url: URL, signal: AbortSignal): Promise<Buffer> {
    const res = await this.get(url.toString(), signal);
    if (!res.ok) throw statusError(res.status);

    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new MediaFetchError('TOO_LARGE', false, 'Media exceeds the size limit');
    }
    if (!res.body) throw new MediaFetchError('BAD_RESPONSE', false, 'Empty media response');

    // Cap enforced on actual bytes; neither file_size nor Content-Length is trusted.
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new MediaFetchError('TOO_LARGE', false, 'Media exceeds the size limit');
      }
      chunks.push(value);
    }
    if (total === 0) throw new MediaFetchError('BAD_RESPONSE', false, 'Empty media response');
    return Buffer.concat(chunks, total);
  }

  private classify(err: unknown, signal: AbortSignal): MediaFetchError {
    if (err instanceof MediaFetchError) return err;
    if (signal.aborted) return new MediaFetchError('TIMEOUT', true, 'Media download timed out');
    return new MediaFetchError('NETWORK', true, 'Media download failed (network error)');
  }
}
