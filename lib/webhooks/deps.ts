import type { Env } from '@/lib/env';
import type { PrismaClient } from '@/lib/generated/prisma/client';
import type { Logger } from '@/lib/logger';
import type { IngestionService } from '@/lib/services/document-ingestion';
import type { MediaFetcher } from '@/lib/services/media-fetcher';

/** Everything a webhook handler needs, injected so handlers can be tested without Next, env vars or a network. */
export interface WebhookDeps {
  db: PrismaClient;
  env: Env;
  ingestion: IngestionService;
  media: MediaFetcher;
  log: Logger;
  /** Run work after the HTTP response has been sent. Must never throw into the request. */
  schedule: (task: () => Promise<void>) => void;
  now: () => Date;
}
