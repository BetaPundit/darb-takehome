import { FIXTURES, fixtureBytes, fixtureHash, fixtureNames, type FixtureName } from '@/lib/extraction/fixtures';
import { sha256Hex } from '@/lib/extraction/hash';
import { extractedDocumentSchema } from '@/lib/extraction/types';

describe('fixtures', () => {
  it.each(fixtureNames)('%s: key, name and content follow the convention', (name) => {
    expect(FIXTURES[name].name).toBe(name);
    expect(FIXTURES[name].content).toBe(`DARB-FIXTURE:${name}`);
    expect(fixtureBytes(name).toString('utf8')).toBe(FIXTURES[name].content);
  });

  it.each(fixtureNames)('%s: expected value satisfies extractedDocumentSchema', (name) => {
    const f: (typeof FIXTURES)[FixtureName] = FIXTURES[name];
    if ('expected' in f) {
      expect(extractedDocumentSchema.safeParse(f.expected).success).toBe(true);
    } else {
      expect(f.throws).toBe('FIXTURE_FORCED_FAILURE');
    }
  });

  it('has every fixture from the shared scenario contract', () => {
    expect([...fixtureNames].sort()).toEqual(
      [
        'exact', 'ambiguous', 'ambiguous_last4', 'tip', 'rounding', 'prevat', 'no_transaction',
        'garbage', 'low_confidence', 'email_exact', 'arabic', 'already_confirmed', 'forced_failure',
      ].sort(),
    );
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

  describe('assignment edge-case categories are each represented', () => {
    const doc = (n: FixtureName) => {
      const f: (typeof FIXTURES)[FixtureName] = FIXTURES[n];
      if (!('expected' in f)) throw new Error(`${n} has no expected document`);
      return f.expected;
    };

    it('exact: complete, high confidence', () => {
      const d = doc('exact');
      expect(d.amountMinor).not.toBeNull();
      expect(d.merchantName).not.toBeNull();
      expect(d.documentDate).not.toBeNull();
      expect(d.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('ambiguous same-amount: two fixtures share merchant, amount and date; last4 variant breaks the tie', () => {
      const a = doc('ambiguous');
      const b = doc('ambiguous_last4');
      expect([b.merchantName, b.amountMinor, b.documentDate]).toEqual([a.merchantName, a.amountMinor, a.documentDate]);
      expect(a.cardLast4).toBeNull();
      expect(b.cardLast4).not.toBeNull();
    });

    it('tip / rounding: amounts deliberately differ from the card amount', () => {
      expect(doc('tip').amountMinor).toBe(6000); // card charged 6600
      expect(doc('rounding').amountMinor).toBe(23100); // card charged 23103
    });

    it('duplicate-capable: identical bytes are identical input', () => {
      expect(fixtureBytes('exact').equals(fixtureBytes('exact'))).toBe(true);
      expect(sha256Hex(fixtureBytes('exact'))).toBe(sha256Hex(fixtureBytes('exact')));
    });

    it('no-transaction invoice: valid tax invoice with an amount no seeded transaction has', () => {
      const d = doc('no_transaction');
      expect(d.documentType).toBe('TAX_INVOICE');
      expect(d.amountMinor).toBe(99999);
    });

    it('garbage: unknown type, nothing extracted, low confidence', () => {
      const d = doc('garbage');
      expect(d.documentType).toBe('UNKNOWN');
      expect(d.amountMinor).toBeNull();
      expect(d.merchantName).toBeNull();
      expect(d.confidence).toBeLessThan(0.5);
    });
  });
});
