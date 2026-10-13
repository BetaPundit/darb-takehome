import { FIXTURES, fixtureHash, fixtureNames, type Fixture } from './fixtures';
import { sha256Hex } from './hash';
import { ExtractionError, type DocumentExtractor, type ExtractedDocument, type ExtractInput } from './types';

/** sha256(bytes) -> fixture. Built once; the mock never looks at mimeType or fileName. */
const FIXTURES_BY_HASH: ReadonlyMap<string, Fixture> = new Map(
  fixtureNames.map((name): [string, Fixture] => [fixtureHash(name), FIXTURES[name]]),
);

export class MockExtractor implements DocumentExtractor {
  async extract(input: ExtractInput): Promise<ExtractedDocument> {
    const fixture = FIXTURES_BY_HASH.get(sha256Hex(input.bytes));
    if (!fixture) throw new ExtractionError('UNKNOWN_FIXTURE');
    if ('throws' in fixture) throw new ExtractionError(fixture.throws);
    // Copy so a caller mutating the result cannot corrupt the shared fixture for later calls.
    return structuredClone(fixture.expected);
  }
}
