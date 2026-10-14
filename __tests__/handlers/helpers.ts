import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defaultFixturesDir, fixtureBytes, type FixtureName } from '@/lib/extraction/fixtures';
import { MockExtractor } from '@/lib/extraction/mock-extractor';
import type { PrismaClient } from '@/lib/generated/prisma/client';
import { silentLogger, type Logger } from '@/lib/logger';
import { parseEnv } from '@/lib/env';
import { InMemoryBlobStore } from '@/lib/services/blob-store';
import { createIngestionService } from '@/lib/services/document-ingestion';
import { FixtureMediaStore } from '@/lib/services/fixture-media-store';
import type { MediaStore } from '@/lib/services/media-store';
import type { WebhookDeps } from '@/lib/webhooks/deps';
import { signPayload } from '@/lib/webhooks/hmac';

const MEDIA_MAP = JSON.parse(readFileSync(path.join(defaultFixturesDir(), 'media-map.json'), 'utf8')) as Record<string, string>;

/** The media id fixtures/media-map.json assigns to a fixture file (e.g. exact -> media_4471). */
export function mediaIdFor(name: FixtureName): string {
  const id = Object.keys(MEDIA_MAP).find((k) => MEDIA_MAP[k] === `documents/${name}.fixture`);
  if (!id) throw new Error(`fixtures/media-map.json has no media id for the "${name}" fixture`);
  return id;
}

export const SECRETS = { email: 'email-secret', whatsapp: 'wa-secret', transactions: 'tx-secret', verify: 'verify-me' };

/** Real handlers, real DB, real ingestion; only the network (media) and "after()" scheduling are test-controlled. */
export function makeDeps(db: PrismaClient, overrides: { media?: MediaStore; env?: Record<string, string>; log?: Logger } = {}) {
  const pending: Promise<void>[] = [];
  const env = parseEnv({
    NODE_ENV: 'test',
    EMAIL_WEBHOOK_SECRET: SECRETS.email,
    WHATSAPP_APP_SECRET: SECRETS.whatsapp,
    TRANSACTIONS_WEBHOOK_SECRET: SECRETS.transactions,
    WHATSAPP_VERIFY_TOKEN: SECRETS.verify,
    ...overrides.env,
  });
  const log = overrides.log ?? silentLogger;
  const ingestion = createIngestionService({ db, extractor: new MockExtractor(), blobs: new InMemoryBlobStore(), log });
  const deps: WebhookDeps = {
    db,
    env,
    ingestion,
    media: overrides.media ?? new FixtureMediaStore(),
    log,
    schedule: (task) => void pending.push(task()), // run immediately, but let the test await completion
    now: () => new Date('2026-10-06T08:00:00Z'),
  };
  /** Wait for everything the handler scheduled "after the response". */
  const drain = async () => {
    while (pending.length) await pending.shift();
  };
  return { deps, drain };
}

export function signedRequest(url: string, payload: unknown | Buffer, secret: string, header = 'x-signature-256', tamper?: (raw: string) => string): Request {
  const raw = Buffer.isBuffer(payload) ? payload.toString('utf8') : JSON.stringify(payload);
  const signature = signPayload(raw, secret);
  return new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', [header]: signature }, body: tamper ? tamper(raw) : raw });
}

export const emailPayload = (
  messageId: string,
  fixtures: FixtureName[],
  from = 'ap@alnoor.example',
) => ({
  messageId,
  from,
  to: ['receipts@darb.sa'],
  subject: 'invoice',
  attachments: fixtures.map((f) => ({ filename: `${f}.jpg`, contentType: 'image/jpeg', contentBase64: fixtureBytes(f).toString('base64') })),
});

export const waPayload = (messages: Array<{ id: string; from: string; media?: string; type?: string; mime?: string }>) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550001111', phone_number_id: '123' },
            messages: messages.map((m) =>
              m.type === 'text'
                ? { id: m.id, from: m.from, timestamp: '1760000000', type: 'text', text: { body: 'hi' } }
                : { id: m.id, from: m.from, timestamp: '1760000000', type: 'image', image: { id: m.media ?? mediaIdFor('exact'), mime_type: m.mime ?? 'image/jpeg' } },
            ),
          },
        },
      ],
    },
  ],
});
