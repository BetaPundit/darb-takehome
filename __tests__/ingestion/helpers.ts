import { fixtureBytes, type FixtureName } from '@/lib/extraction/fixtures';
import { MockExtractor } from '@/lib/extraction/mock-extractor';
import type { DocumentExtractor } from '@/lib/extraction/types';
import type { PrismaClient } from '@/lib/generated/prisma/client';
import { silentLogger } from '@/lib/logger';
import { InMemoryBlobStore } from '@/lib/services/blob-store';
import { createIngestionService, type SenderScope } from '@/lib/services/document-ingestion';

export const DRIVER_1 = { kind: 'WHATSAPP', phone: '+966501111111' } as const satisfies SenderScope;
export const DRIVER_2 = { kind: 'WHATSAPP', phone: '+966502222222' } as const satisfies SenderScope;
export const DESERT_DRIVER = { kind: 'WHATSAPP', phone: '+966503333333' } as const satisfies SenderScope;
export const ALNOOR_EMAIL = { kind: 'EMAIL', clientId: 'client_alnoor', email: 'ap@alnoor.example' } as const satisfies SenderScope;
export const DESERT_EMAIL = { kind: 'EMAIL', clientId: 'client_desert', email: 'accounts@desertfleet.example' } as const satisfies SenderScope;

export function makeService(db: PrismaClient, overrides: { extractor?: DocumentExtractor; extractionTimeoutMs?: number; leaseMs?: number; now?: () => Date } = {}) {
  const blobs = new InMemoryBlobStore();
  const service = createIngestionService({ db, extractor: overrides.extractor ?? new MockExtractor(), blobs, log: silentLogger, ...overrides });
  return { service, blobs };
}

let counter = 0;
export const nextMessageId = () => `msg-${++counter}`;

/** accept() one fixture then run phase B on it, like a real webhook + after() would. */
export async function sendFixture(
  service: ReturnType<typeof makeService>['service'],
  name: FixtureName,
  scope: SenderScope,
  messageId = nextMessageId(),
) {
  const [accepted] = await service.accept({
    source: scope.kind,
    externalMessageId: messageId,
    scope,
    attachments: [{ fileName: `${name}.jpg`, mimeType: 'image/jpeg', bytes: fixtureBytes(name) }],
  });
  const result = await service.processDocument(accepted!.documentId);
  return { documentId: accepted!.documentId, result };
}
