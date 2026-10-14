import { documentDay, isValidDocumentDate } from '@/lib/matching/dates';

const RIYADH = 180;
const epochDay = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`) / 86_400_000;

describe('documentDay: the calendar day a document date falls on in a fixed UTC offset', () => {
  it('date-only means that calendar day, whatever the offset', () => {
    expect(documentDay('2026-10-02', RIYADH)).toBe(epochDay('2026-10-02'));
    expect(documentDay('2026-10-02', 0)).toBe(epochDay('2026-10-02'));
    expect(documentDay('2026-10-02', -600)).toBe(epochDay('2026-10-02'));
  });

  it('a Z datetime late in the evening UTC is the NEXT day in Riyadh', () => {
    expect(documentDay('2026-10-01T22:30:00Z', RIYADH)).toBe(epochDay('2026-10-02'));
    expect(documentDay('2026-10-01T22:30:00Z', 0)).toBe(epochDay('2026-10-01'));
  });

  it('the Riyadh day boundary is exactly 21:00:00Z', () => {
    expect(documentDay('2026-10-01T20:59:59Z', RIYADH)).toBe(epochDay('2026-10-01'));
    expect(documentDay('2026-10-01T21:00:00Z', RIYADH)).toBe(epochDay('2026-10-02'));
  });

  it.each([
    ['the same offset as Riyadh keeps its printed day', '2026-10-01T09:15:00+03:00', '2026-10-01'],
    ['just after Riyadh midnight stays on that day although UTC is still the day before', '2026-10-01T00:30:00+03:00', '2026-10-01'],
    ['a western offset in the evening rolls forward to the next Riyadh day', '2026-10-01T23:30:00-05:00', '2026-10-02'],
    ['an eastern offset just after midnight rolls back to the previous Riyadh day', '2026-10-01T02:00:00+05:30', '2026-09-30'],
  ])('offset datetime: %s', (_name, iso, expected) => {
    expect(documentDay(iso, RIYADH)).toBe(epochDay(expected));
  });

  it('accepts optional seconds and fractional seconds', () => {
    expect(documentDay('2026-10-01T22:30Z', RIYADH)).toBe(epochDay('2026-10-02'));
    expect(documentDay('2026-10-01T22:30:00.123Z', RIYADH)).toBe(epochDay('2026-10-02'));
  });

  it('works across a month and a year boundary and on a leap day', () => {
    expect(documentDay('2025-12-31T21:00:00Z', RIYADH)).toBe(epochDay('2026-01-01'));
    expect(documentDay('2024-02-29', RIYADH)).toBe(epochDay('2024-02-29'));
    expect(documentDay('2024-02-28T21:00:00Z', RIYADH)).toBe(epochDay('2024-02-29'));
  });

  it.each([
    '',
    'garbage',
    '2026-02-30', // impossible day
    '2026-02-29', // 2026 is not a leap year
    '2026-13-01',
    '2026-00-10',
    '2026-10-32',
    '2026-1-1',
    '20261001',
    '1 Oct 2026',
    ' 2026-10-01',
    '2026-10-01 ',
    '2026-10-01abc',
    '2026-10-01\n',
    '2026-10-01Z',
    '٢٠٢٦-١٠-٠١', // Arabic-Indic digits are not ISO 8601
    '2026-10-01 09:15', // space instead of T
    '2026-10-01T09:15:00', // a datetime without Z or an offset is ambiguous: rejected
    '2026-10-01T24:00:00Z',
    '2026-10-01T09:60:00Z',
    '2026-10-01T09:15:60Z',
    '2026-10-01T09:15:00+24:00',
    '2026-10-01T09:15:00+03',
    '2026-10-01T09:15:00z',
    '2026-10-01t09:15:00Z',
    '2026-02-30T10:00:00Z',
  ])('rejects %p as unusable', (iso) => {
    expect(documentDay(iso, RIYADH)).toBeNull();
    expect(isValidDocumentDate(iso)).toBe(false);
  });

  it('isValidDocumentDate accepts exactly what documentDay can interpret', () => {
    for (const iso of ['2026-10-01', '2025-06-14T09:21:00Z', '2026-10-01T09:15:00+03:00', '2026-10-01T09:15:00-11:30']) {
      expect(isValidDocumentDate(iso)).toBe(true);
      expect(documentDay(iso, RIYADH)).not.toBeNull();
    }
  });
});
