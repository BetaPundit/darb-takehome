import { jaroWinkler, merchantSimilarity, tokenSetRatio } from '@/lib/matching/similarity';

describe('jaroWinkler (published reference values)', () => {
  it.each([
    ['MARTHA', 'MARHTA', 0.9611],
    ['DIXON', 'DICKSONX', 0.8133],
    ['DWAYNE', 'DUANE', 0.84],
  ])('%s vs %s', (a, b, expected) => {
    expect(jaroWinkler(a, b)).toBeCloseTo(expected, 4);
  });

  it('is 1 for identical, 0 for disjoint, and handles empty strings', () => {
    expect(jaroWinkler('baik', 'baik')).toBe(1);
    expect(jaroWinkler('abc', 'xyz')).toBe(0);
    expect(jaroWinkler('', '')).toBe(1);
    expect(jaroWinkler('', 'abc')).toBe(0);
    expect(jaroWinkler('abc', '')).toBe(0);
  });

  it('is symmetric', () => {
    expect(jaroWinkler('starbucks', 'starbuzzcafe')).toBe(jaroWinkler('starbuzzcafe', 'starbucks'));
  });
});

describe('tokenSetRatio', () => {
  it('is 1 when one token set is a subset of the other', () => {
    expect(tokenSetRatio(['aramco', 'retail', 'station'], ['aramco', 'retail'])).toBe(1);
    expect(tokenSetRatio(['aramco', 'retail'], ['aramco', 'retail', 'station'])).toBe(1);
    expect(tokenSetRatio(['a', 'b'], ['b', 'a'])).toBe(1);
  });

  it('is 0 when either side is empty or nothing overlaps', () => {
    expect(tokenSetRatio([], ['a'])).toBe(0);
    expect(tokenSetRatio(['a'], [])).toBe(0);
    expect(tokenSetRatio(['a'], ['b'])).toBe(0);
  });

  it('gives partial credit for partial overlap (Dice coefficient)', () => {
    // 2*1 / (2+2)
    expect(tokenSetRatio(['x', 'y'], ['x', 'z'])).toBe(0.5);
  });
});

describe('merchantSimilarity: real merchant strings', () => {
  it.each([
    ['Al Baik', 'ALBAIK FOOD SYSTEMS CO'],
    ['Starbucks Coffee Company', 'STARBUCKS #12345 RIYADH'],
    ['ADNOC DISTRIBUTION LLC', 'ADNOC Distribution'],
    ['Panda Retail Co.', 'PANDA RETAIL CO.'],
    ['Aramco Retail', 'ARAMCO RETAIL 0412'],
    ['Aramco Retail Station 0412', 'ARAMCO RETAIL 0412'],
    ['Jarir Bookstore', 'JARIR BOOKSTORE RIYADH BRANCH'],
    ['مطعم البيك - فرع الرياض', 'مطعم البيك'],
    ['SASCO Station 118', 'SASCO STATION 118'],
  ])('%s ~ %s = 1', (a, b) => {
    expect(merchantSimilarity(a, b)).toBe(1);
  });

  it('is symmetric', () => {
    expect(merchantSimilarity('Al Baik', 'Al Rajhi Bank')).toBe(merchantSimilarity('Al Rajhi Bank', 'Al Baik'));
  });

  it('scores unrelated merchants low: "Al Baik" vs "Al Rajhi Bank"', () => {
    expect(merchantSimilarity('Al Baik', 'Al Rajhi Bank')).toBeLessThan(0.6);
  });

  it('does not treat near-miss names as identical: "Starbucks" vs "Starbuzz Cafe"', () => {
    const s = merchantSimilarity('Starbucks', 'Starbuzz Cafe');
    expect(s).toBeLessThan(1);
    expect(s).toBeLessThan(0.9);
  });

  it('tolerates a one-character OCR slip', () => {
    expect(merchantSimilarity('Starbucks', 'Starbucks')).toBe(1);
    expect(merchantSimilarity('Starbucks', 'Starbuck5')).toBeGreaterThan(0.9);
  });

  it('is 0 when either side is empty after normalization', () => {
    expect(merchantSimilarity('', 'Al Baik')).toBe(0);
    expect(merchantSimilarity('Co. Ltd', 'Al Baik')).toBe(0);
    expect(merchantSimilarity('Al Baik', '#123')).toBe(0);
  });

  it('KNOWN LIMITATION: cross-script names (Arabic vs English) are not matched, no alias table', () => {
    expect(merchantSimilarity('مكتبة جرير', 'Jarir Bookstore')).toBeLessThan(0.3);
  });
});
