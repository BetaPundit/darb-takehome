import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { sha256Hex } from './hash';
import { EXTRACTION_ERROR_CODES, extractedDocumentSchema, type ExtractedDocument, type ExtractionErrorCode } from './types';

/**
 * Deterministic "OCR" fixtures, loaded from the repo's fixtures/ directory, which is their single source of truth.
 *   fixtures/documents/<name>.fixture   the bytes of the "file" that arrives; the mock looks a file up by the sha256 of these bytes
 *   fixtures/extractions/<name>.json    what the mock OCR returns for it (ExtractedDocument), or { "throws": "<ExtractionErrorCode>" }
 * Read synchronously when this module is first imported; a missing directory or an invalid file fails loudly, naming the culprit.
 */

/** Hand-written so `FixtureName` is a real union. A test asserts it equals the files on disk, so a new file without an entry here fails CI. */
export const FIXTURE_NAMES = [
  'exact',
  'ambiguous',
  'ambiguous_last4',
  'tip',
  'rounding',
  'prevat',
  'no_transaction',
  'garbage',
  'low_confidence',
  'email_exact',
  'arabic',
  'already_confirmed',
  'forced_failure',
  'alfanar_invoice',
  'restaurant_tip',
] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

export type Fixture =
  | { name: string; bytes: Buffer; expected: ExtractedDocument }
  | { name: string; bytes: Buffer; throws: ExtractionErrorCode };

/** `fixtures/` at the project root. The server is always started from the project root (next dev/start, jest, tsx scripts). */
export const defaultFixturesDir = (): string => path.resolve(process.cwd(), 'fixtures');

const failureSchema = z.object({ throws: z.enum(EXTRACTION_ERROR_CODES) }).strict();
// strict(): a typo'd or leftover key in a fixture is an error here, not silently dropped like it is for real extractor output
const strictExtractionSchema = extractedDocumentSchema.strict();

function describeIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

function readFixtureFile(dir: string, name: string, relative: string): Buffer {
  try {
    return readFileSync(path.join(dir, relative));
  } catch {
    throw new Error(`Fixture "${name}": cannot read ${relative} in ${dir}`);
  }
}

export function loadFixtures<N extends string>(dir: string, names: readonly N[]): Record<N, Fixture> {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Fixtures directory not found: ${dir} (expected documents/<name>.fixture and extractions/<name>.json; run the server from the project root)`);
  }

  const loaded = {} as Record<N, Fixture>;
  const byHash = new Map<string, string>();
  for (const name of names) {
    const bytes = readFixtureFile(dir, name, `documents/${name}.fixture`);
    const hash = sha256Hex(bytes);
    const clash = byHash.get(hash);
    if (clash !== undefined) throw new Error(`Fixtures "${clash}" and "${name}" have identical bytes: the mock extractor looks files up by hash, so one would shadow the other`);
    byHash.set(hash, name);

    const file = `extractions/${name}.json`;
    let json: unknown;
    try {
      json = JSON.parse(readFixtureFile(dir, name, file).toString('utf8'));
    } catch (err) {
      if (err instanceof SyntaxError) throw new Error(`Fixture "${name}": ${file} is not valid JSON`);
      throw err;
    }

    if (typeof json === 'object' && json !== null && 'throws' in json) {
      const failure = failureSchema.safeParse(json);
      if (!failure.success) throw new Error(`Fixture "${name}": ${file} must be { "throws": "<ExtractionErrorCode>" } (${describeIssues(failure.error)})`);
      loaded[name] = { name, bytes, throws: failure.data.throws };
      continue;
    }
    const parsed = strictExtractionSchema.safeParse(json);
    if (!parsed.success) throw new Error(`Fixture "${name}": ${file} does not satisfy the ExtractedDocument schema (${describeIssues(parsed.error)})`);
    loaded[name] = { name, bytes, expected: parsed.data };
  }
  return loaded;
}

export const FIXTURES: Record<FixtureName, Fixture> = loadFixtures(defaultFixturesDir(), FIXTURE_NAMES);

export const fixtureNames: readonly FixtureName[] = FIXTURE_NAMES;

/** A copy: callers may mutate it without corrupting the loaded fixture. */
export function fixtureBytes(name: FixtureName): Buffer {
  return Buffer.from(FIXTURES[name].bytes);
}

export function fixtureHash(name: FixtureName): string {
  return sha256Hex(FIXTURES[name].bytes);
}

/** The extraction a fixture returns. Throws for a deliberate-failure fixture. A copy, like what MockExtractor returns. */
export function fixtureExpected(name: FixtureName): ExtractedDocument {
  const f = FIXTURES[name];
  if (!('expected' in f)) throw new Error(`Fixture "${name}" is a deliberate failure (${f.throws}), it has no extraction`);
  return structuredClone(f.expected);
}
