import { after } from 'next/server';
import { db } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { createExtractor } from '@/lib/extraction';
import { consoleLogger, errorFields } from '@/lib/logger';
import { LocalFsBlobStore } from '@/lib/services/blob-store';
import { createIngestionService } from '@/lib/services/document-ingestion';
import { FixtureMediaFetcher, UnconfiguredMediaFetcher } from '@/lib/services/fixture-media-fetcher';
import { WhatsAppMediaFetcher, type MediaFetcher } from '@/lib/services/media-fetcher';
import type { WebhookDeps } from '@/lib/webhooks/deps';

let cached: WebhookDeps | undefined;

/** Default wiring. Built lazily on first request so `next build` never needs runtime env vars. */
export function getWebhookDeps(): WebhookDeps {
  if (cached) return cached;
  const env = getEnv();
  const log = consoleLogger;

  const media: MediaFetcher = env.WHATSAPP_ACCESS_TOKEN
    ? new WhatsAppMediaFetcher({ accessToken: env.WHATSAPP_ACCESS_TOKEN, maxBytes: env.MAX_BODY_BYTES })
    : env.NODE_ENV === 'production'
      ? new UnconfiguredMediaFetcher()
      : new FixtureMediaFetcher();

  const ingestion = createIngestionService({
    db,
    extractor: createExtractor({ kind: env.EXTRACTOR, anthropicApiKey: env.ANTHROPIC_API_KEY }),
    blobs: new LocalFsBlobStore(env.BLOB_DIR),
    log,
  });

  const schedule: WebhookDeps['schedule'] = (task) => {
    const safe = () => task().catch((err: unknown) => log.error('background.failed', errorFields(err)));
    try {
      after(safe); // runs after the response is flushed, and keeps the serverless invocation alive
    } catch {
      void safe(); // no request scope (scripts, tests): fire and forget
    }
  };

  cached = { db, env, ingestion, media, log, schedule, now: () => new Date() };
  return cached;
}
