import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  FIXTURES,
  FIXTURE_NAMES,
  defaultFixturesDir,
  fixtureBytes,
  fixtureExpected,
  fixtureHash,
  fixtureNames,
  loadFixtures,
} from '@/lib/extraction/fixtures';
import { sha256Hex } from '@/lib/extraction/hash';
import { extractedDocumentSchema } from '@/lib/extraction/types';

const ROOT = defaultFixturesDir();
const namesOnDisk = (sub: string, ext: string) =>
  readdirSync(path.join(ROOT, sub))
    .filter((f) => f.endsWith(ext))
    .map((f) => f.slice(0, -ext.length))
    .sort();

describe('fixtures: loaded from the fixtures/ directory (the single source of truth)', () => {
  it('resolves the directory from the project root', () => {
    expect(ROOT).toBe(path.resolve(process.cwd(), 'fixtures'));
  });

  it('the FixtureName union equals the files on disk, so a new fixture file without a union entry fails CI', () => {
    const union = [...FIXTURE_NAMES].sort();
    expect(namesOnDisk('documents', '.fixture')).toEqual(union);
    expect(namesOnDisk('extractions', '.json')).toEqual(union);
    expect([...fixtureNames].sort()).toEqual(union);
  });

  it('has the 15 fixtures: the original 13 plus the assignment email sample and a restaurant tip', () => {
    expect([...fixtureNames].sort()).toEqual(
      [
        'exact', 'ambiguous', 'ambiguous_last4', 'tip', 'rounding', 'prevat', 'no_transaction',
        'garbage', 'low_confidence', 'email_exact', 'arabic', 'already_confirmed', 'forced_failure',
        'alfanar_invoice', 'restaurant_tip',
      ].sort(),
    );
  });

  it.each(fixtureNames)('%s: key and name agree and the file bytes are exactly DARB-FIXTURE:<name> (no trailing newline)', (name) => {
    expect(FIXTURES[name].name).toBe(name);
    expect(fixtureBytes(name).toString('utf8')).toBe(`DARB-FIXTURE:${name}`);
    expect(fixtureBytes(name).equals(readFileSync(path.join(ROOT, 'documents', `${name}.fixture`)))).toBe(true);
  });

  it.each(fixtureNames)('%s: the extraction satisfies the strict ExtractedDocument schema (or is a deliberate failure)', (name) => {
    const f = FIXTURES[name];
    if ('expected' in f) expect(extractedDocumentSchema.strict().safeParse(f.expected).success).toBe(true);
    else expect(f.throws).toBe('FIXTURE_FORCED_FAILURE');
  });

  it('hashes are unique across fixtures and are sha256 hex', () => {
    const hashes = fixtureNames.map(fixtureHash);
    expect(new Set(hashes).size).toBe(hashes.length);
    hashes.forEach((h) => expect(h).toMatch(/^[0-9a-f]{64}$/));
  });

  it('the same bytes always hash equal (duplicate-capable)', () => {
    expect(sha256Hex(fixtureBytes('exact'))).toBe(sha256Hex(Buffer.from('DARB-FIXTURE:exact')));
    expect(sha256Hex(fixtureBytes('exact'))).toBe(fixtureHash('exact'));
  });

  it('fixtureBytes returns a copy: mutating it cannot corrupt the loaded fixture', () => {
    const copy = fixtureBytes('exact');
    copy.fill(0);
    expect(fixtureBytes('exact').toString('utf8')).toBe('DARB-FIXTURE:exact');
  });

  it('fixtureExpected returns the extraction, and refuses a deliberate-failure fixture', () => {
    expect(fixtureExpected('exact').merchantName).toBe('Aramco Retail Station 0412');
    expect(() => fixtureExpected('forced_failure')).toThrow(/forced_failure/);
  });

  it('webhook samples reference real fixtures: every email attachment is a fixture file', () => {
    const sample = JSON.parse(readFileSync(path.join(ROOT, 'webhooks', 'email-alfanar-invoice.json'), 'utf8')) as {
      attachments: { contentBase64: string }[];
    };
    const hashes = new Set(fixtureNames.map(fixtureHash));
    for (const a of sample.attachments) expect(hashes.has(sha256Hex(Buffer.from(a.contentBase64, 'base64')))).toBe(true);
  });

  describe('assignment edge-case categories are each represented', () => {
    it('exact: complete, high confidence, datetime with an offset', () => {
      const d = fixtureExpected('exact');
      expect(d.totalAmount).not.toBeNull();
      expect(d.merchantName).not.toBeNull();
      expect(d.documentDate).toBe('2026-10-01T09:15:00+03:00');
      expect(d.extractionConfidence).toBeGreaterThanOrEqual(0.9);
    });

    it('ambiguous same-amount: two fixtures share merchant, amount and date; last4 variant breaks the tie', () => {
      const a = fixtureExpected('ambiguous');
      const b = fixtureExpected('ambiguous_last4');
      expect([b.merchantName, b.totalAmount, b.documentDate]).toEqual([a.merchantName, a.totalAmount, a.documentDate]);
      expect(a.cardLast4).toBeNull();
      expect(b.cardLast4).not.toBeNull();
    });

    it('tip / rounding: amounts deliberately differ from the card amount', () => {
      expect(fixtureExpected('tip').totalAmount).toBe(6000); // card charged 6600
      expect(fixtureExpected('rounding').totalAmount).toBe(23100); // card charged 23103
    });

    it('duplicate-capable: identical bytes are identical input', () => {
      expect(fixtureBytes('exact').equals(fixtureBytes('exact'))).toBe(true);
      expect(sha256Hex(fixtureBytes('exact'))).toBe(sha256Hex(fixtureBytes('exact')));
    });

    it('no-transaction invoice: valid tax invoice with an amount no seeded transaction has', () => {
      const d = fixtureExpected('no_transaction');
      expect(d.documentType).toBe('TAX_INVOICE');
      expect(d.totalAmount).toBe(99999);
    });

    it('garbage: unknown type, nothing extracted, low confidence', () => {
      const d = fixtureExpected('garbage');
      expect(d.documentType).toBe('UNKNOWN');
      expect(d.totalAmount).toBeNull();
      expect(d.merchantName).toBeNull();
      expect(d.extractionConfidence).toBeLessThan(0.5);
    });

    it('the assignment email sample: a tax invoice with a 15-digit VAT number and an invoice number', () => {
      const d = fixtureExpected('alfanar_invoice');
      expect(d.documentType).toBe('TAX_INVOICE');
      expect(d.vatNumber).toMatch(/^\d{15}$/);
      expect(d.invoiceNumber).toBe('INV-99812');
    });

    it('restaurant tip: a receipt whose total is below what the card was charged', () => {
      const d = fixtureExpected('restaurant_tip');
      expect(d.documentType).toBe('RECEIPT');
      expect(d.totalAmount).toBe(5750);
    });
  });
});

describe('loadFixtures: failure modes are loud and name the culprit', () => {
  let dir: string;
  const goodDoc = {
    documentType: 'RECEIPT', merchantName: 'M', vatNumber: null, totalAmount: 100, currency: 'SAR', documentDate: '2026-10-01',
    cardLast4: null, invoiceNumber: null, rawText: 't', extractionConfidence: 0.9,
  };

  /** A temp fixtures/ dir with the given files; `documents` and `extractions` map name -> file content. */
  function build(documents: Record<string, string | Buffer>, extractions: Record<string, unknown | string>): string {
    const d = mkdtempSync(path.join(tmpdir(), 'darb-fixtures-'));
    mkdirSync(path.join(d, 'documents'));
    mkdirSync(path.join(d, 'extractions'));
    for (const [n, c] of Object.entries(documents)) writeFileSync(path.join(d, 'documents', `${n}.fixture`), c);
    for (const [n, c] of Object.entries(extractions)) writeFileSync(path.join(d, 'extractions', `${n}.json`), typeof c === 'string' ? c : JSON.stringify(c));
    return d;
  }

  beforeEach(() => void (dir = ''));
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('loads bytes exactly (no trimming) and a valid extraction', () => {
    dir = build({ a: 'DARB-FIXTURE:a\n', b: Buffer.from([0xff, 0x00, 0xfe]) }, { a: goodDoc, b: { throws: 'TIMEOUT' } });
    const loaded = loadFixtures(dir, ['a', 'b']);
    expect(loaded.a.bytes.toString('utf8')).toBe('DARB-FIXTURE:a\n');
    expect(loaded.a).toMatchObject({ name: 'a', expected: goodDoc });
    expect([...loaded.b.bytes]).toEqual([0xff, 0x00, 0xfe]);
    expect(loaded.b).toMatchObject({ name: 'b', throws: 'TIMEOUT' });
  });

  it('a missing directory fails with the directory in the message', () => {
    const missing = path.join(tmpdir(), 'darb-no-such-fixtures-dir');
    expect(() => loadFixtures(missing, ['a'])).toThrow(/Fixtures directory not found/);
    expect(() => loadFixtures(missing, ['a'])).toThrow(missing);
  });

  it('a missing document file names the fixture and the file', () => {
    dir = build({}, { a: goodDoc });
    expect(() => loadFixtures(dir, ['a'])).toThrow(/Fixture "a".*documents\/a\.fixture/);
  });

  it('a missing extraction file names the fixture and the file', () => {
    dir = build({ a: 'x' }, {});
    expect(() => loadFixtures(dir, ['a'])).toThrow(/Fixture "a".*extractions\/a\.json/);
  });

  it('invalid JSON names the file', () => {
    dir = build({ a: 'x' }, { a: '{ not json' });
    expect(() => loadFixtures(dir, ['a'])).toThrow(/Fixture "a".*extractions\/a\.json.*not valid JSON/);
  });

  it('an extraction in the pre-rename shape (amountMinor / confidence) is rejected', () => {
    const { totalAmount, extractionConfidence, ...rest } = goodDoc;
    dir = build({ a: 'x' }, { a: { ...rest, amountMinor: totalAmount, confidence: extractionConfidence } });
    expect(() => loadFixtures(dir, ['a'])).toThrow(/Fixture "a".*schema/);
  });

  it('an unknown extra key (a typo) is rejected rather than silently dropped', () => {
    dir = build({ a: 'x' }, { a: { ...goodDoc, currencyy: 'SAR' } });
    expect(() => loadFixtures(dir, ['a'])).toThrow(/Fixture "a".*schema/);
  });

  it('an impossible documentDate is rejected', () => {
    dir = build({ a: 'x' }, { a: { ...goodDoc, documentDate: '2026-02-30' } });
    expect(() => loadFixtures(dir, ['a'])).toThrow(/Fixture "a".*documentDate/);
  });

  it.each([{ throws: 'NOT_A_CODE' }, { throws: 'TIMEOUT', extra: 1 }, { throws: 5 }])('a bad failure fixture %j is rejected', (bad) => {
    dir = build({ a: 'x' }, { a: bad });
    expect(() => loadFixtures(dir, ['a'])).toThrow(/Fixture "a"/);
  });

  it('two fixtures with identical bytes are rejected (the mock looks up by hash, so one would shadow the other)', () => {
    dir = build({ a: 'same', b: 'same' }, { a: goodDoc, b: goodDoc });
    expect(() => loadFixtures(dir, ['a', 'b'])).toThrow(/"a" and "b".*identical bytes/);
  });
});
