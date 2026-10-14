import { FIXTURES, fixtureHash, fixtureNames, type Fixture } from './fixtures';
import { sha256Hex } from './hash';
import { ExtractionError, type DocumentExtractor } from './types';

/** sha256(bytes) -> fixture. Built once; the mock never looks at mimeType. */
const FIXTURES_BY_HASH: ReadonlyMap<string, Fixture> = new Map(
  fixtureNames.map((name): [string, Fixture] => [fixtureHash(name), FIXTURES[name]]),
);

export class MockExtractor implements DocumentExtractor {
  // Typed by the interface so callers can pass (file, mimeType); the mock keys on content only and ignores the mime type.
  extract: DocumentExtractor['extract'] = async (file) => {
    const fixture = FIXTURES_BY_HASH.get(sha256Hex(file));
    if (!fixture) throw new ExtractionError('UNKNOWN_FIXTURE');
    if ('throws' in fixture) throw new ExtractionError(fixture.throws);
    // Copy so a caller mutating the result cannot corrupt the shared fixture for later calls.
    return structuredClone(fixture.expected);
  };
}
