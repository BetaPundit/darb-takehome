import { candidateWindow } from '@/lib/services/match-pipeline';

const NOW = new Date('2026-10-14T08:00:00Z');
const iso = (d: Date) => d.toISOString();

describe('candidateWindow: which transactions are loaded for a document date (Riyadh calendar days)', () => {
  it('date-only: 3 days before the start of that Riyadh day, up to the end of the 14th day after it', () => {
    const w = candidateWindow('2026-10-01', NOW);
    expect(iso(w.from)).toBe('2026-09-27T21:00:00.000Z'); // Sep 28 00:00 Riyadh
    expect(iso(w.to)).toBe('2026-10-15T21:00:00.000Z'); // Oct 16 00:00 Riyadh (exclusive)
  });

  it('a Z datetime late in the evening UTC uses the NEXT Riyadh day', () => {
    const w = candidateWindow('2026-10-01T22:30:00Z', NOW); // Oct 2, 01:30 in Riyadh
    expect(iso(w.from)).toBe('2026-09-28T21:00:00.000Z');
    expect(iso(w.to)).toBe('2026-10-16T21:00:00.000Z');
  });

  it('a Riyadh-offset datetime gives the same window as its date-only form', () => {
    expect(candidateWindow('2026-10-01T09:15:00+03:00', NOW)).toEqual(candidateWindow('2026-10-01', NOW));
    expect(candidateWindow('2026-10-01T00:05:00+03:00', NOW)).toEqual(candidateWindow('2026-10-01', NOW));
  });

  it.each([null, '', 'garbage', '2026-02-30', '2026-10-01T09:15:00'])('%p falls back to the last 30 days from now', (bad) => {
    const w = candidateWindow(bad, NOW);
    expect(iso(w.from)).toBe('2026-09-14T08:00:00.000Z');
    expect(iso(w.to)).toBe('2026-10-15T08:00:00.000Z');
  });
});
