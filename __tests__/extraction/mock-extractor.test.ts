import { FIXTURES, fixtureBytes, fixtureExpected, fixtureNames } from '@/lib/extraction/fixtures';
import { MockExtractor } from '@/lib/extraction/mock-extractor';
import { ExtractionError } from '@/lib/extraction/types';

const extractor = new MockExtractor();
const call = (file: Buffer) => extractor.extract(file, 'image/png');
const successNames = fixtureNames.filter((n) => 'expected' in FIXTURES[n]);

describe('MockExtractor', () => {
  it.each(successNames)('returns the fixture for the bytes of %s', async (name) => {
    await expect(call(fixtureBytes(name))).resolves.toEqual(fixtureExpected(name));
  });

  it('ignores mimeType (lookup is by content only)', async () => {
    const r = await extractor.extract(fixtureBytes('exact'), 'application/pdf');
    expect(r).toEqual(fixtureExpected('exact'));
  });

  it('throws UNKNOWN_FIXTURE for unknown bytes', async () => {
    await expect(call(Buffer.from('some other file'))).rejects.toMatchObject({
      name: 'ExtractionError',
      code: 'UNKNOWN_FIXTURE',
    });
    await expect(call(Buffer.alloc(0))).rejects.toBeInstanceOf(ExtractionError);
  });

  it('forced_failure throws FIXTURE_FORCED_FAILURE', async () => {
    await expect(call(fixtureBytes('forced_failure'))).rejects.toMatchObject({ code: 'FIXTURE_FORCED_FAILURE' });
  });

  it('returns a defensive copy: mutating a result cannot change later results or the fixture', async () => {
    const first = await call(fixtureBytes('exact'));
    first.totalAmount = 1;
    first.merchantName = 'tampered';
    const second = await call(fixtureBytes('exact'));
    expect(second).toEqual(fixtureExpected('exact'));
    expect(second).not.toBe(first);
    expect(fixtureExpected('exact').totalAmount).toBe(18750);
    expect(FIXTURES.exact).toHaveProperty('expected.totalAmount', 18750); // the loaded fixture itself is untouched
  });

  it('is deterministic: same bytes give equal results, including via a separate Buffer instance and a new extractor', async () => {
    const a = await call(fixtureBytes('tip'));
    const b = await call(Buffer.from('DARB-FIXTURE:tip', 'utf8'));
    const c = await new MockExtractor().extract(fixtureBytes('tip'), 'image/jpeg');
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
});
