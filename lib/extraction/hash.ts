import { createHash } from 'node:crypto';

/** Single definition of the content hash, shared by the mock extractor, fixtures and the ingestion service. */
export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
