import { FIXTURES, fixtureBytes, fixtureNames, type FixtureName } from '@/lib/extraction/fixtures';
import { MockExtractor } from '@/lib/extraction/mock-extractor';
import { ExtractionError } from '@/lib/extraction/types';

const extractor = new MockExtractor();
const call = (bytes: Buffer) => extractor.extract({ bytes, mimeType: 'image/png' });
const successNames = fixtureNames.filter((n) => 'expected' in FIXTURES[n]);

describe('MockExtractor', () => {
  it.each(successNames)('returns the fixture for the bytes of %s', async (name) => {
    const f: (typeof FIXTURES)[FixtureName] = FIXTURES[name];
    if (!('expected' in f)) throw new Error('unreachable');
    await expect(call(fixtureBytes(name))).resolves.toEqual(f.expected);
  });

  it('ignores mimeType and fileName (lookup is by content only)', async () => {
    const r = await extractor.extract({ bytes: fixtureBytes('exact'), mimeType: 'application/pdf', fileName: 'x.pdf' });
    expect(r).toEqual(FIXTURES.exact.expected);
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
    first.amountMinor = 1;
    first.merchantName = 'tampered';
    const second = await call(fixtureBytes('exact'));
    expect(second).toEqual(FIXTURES.exact.expected);
    expect(second).not.toBe(first);
    expect(FIXTURES.exact.expected.amountMinor).toBe(18750);
  });

  it('is deterministic: same bytes give equal results, including via a separate Buffer instance and a new extractor', async () => {
    const a = await call(fixtureBytes('tip'));
    const b = await call(Buffer.from(FIXTURES.tip.content, 'utf8'));
    const c = await new MockExtractor().extract({ bytes: fixtureBytes('tip'), mimeType: 'image/jpeg' });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
});
