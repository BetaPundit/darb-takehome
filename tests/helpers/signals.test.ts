import { DEFAULT_MATCHER_CONFIG as cfg } from '@/lib/config/matching';
import { amountSignal, cardSignal, dateSignal, merchantSignal, round4 } from '@/lib/matching/signals';

/** 12:00 Riyadh on the given calendar day, as a UTC instant. */
const riyadhNoon = (ymd: string) => new Date(`${ymd}T09:00:00Z`);

describe('round4', () => {
  it('removes float noise so thresholds compare exactly', () => {
    expect(round4(0.35 + 0.3 + 0.2)).toBe(0.85);
    expect(round4(0.9 - 0.8)).toBe(0.1);
  });
});

describe('amountSignal (doc = 10000 halalas, tipMax = 2000, pre-VAT total = 11500)', () => {
  const doc = 10000;
  const sig = (txn: number) => amountSignal(txn, doc, cfg);

  it('exact => 1.00, no flags', () => {
    expect(sig(10000)).toEqual({ value: 1, flags: [] });
  });

  it.each([1, 3, 5, -1, -5])('rounding difference of %i halalas => 0.97, no flags', (d) => {
    expect(sig(doc + d)).toEqual({ value: 0.97, flags: [] });
  });

  it('tip: 0.85 - 0.45 * d/tipMax, flagged TIP_SUSPECTED', () => {
    expect(sig(doc + 8)).toEqual({ value: 0.8482, flags: ['TIP_SUSPECTED'] });
    expect(sig(doc + 1000)).toEqual({ value: 0.625, flags: ['TIP_SUSPECTED'] });
  });

  // The pre-VAT window (1.15x..1.38x doc) overlaps the tip window's upper end, so the tipMax boundary is tested with VAT off.
  const noVat = { ...cfg, vatBps: 0 };

  it('tip at exactly tipMax => 0.40 (boundary is inclusive)', () => {
    expect(amountSignal(doc + 2000, doc, noVat)).toEqual({ value: 0.4, flags: ['TIP_SUSPECTED'] });
  });

  it('tip just past tipMax => 0, no flags', () => {
    expect(amountSignal(doc + 2001, doc, noVat)).toEqual({ value: 0, flags: [] });
  });

  it('charge below the invoice beyond rounding => 0 with AMOUNT_BELOW_CHARGE (asymmetric tip rule)', () => {
    expect(sig(doc - 6)).toEqual({ value: 0, flags: ['AMOUNT_BELOW_CHARGE'] });
    expect(sig(doc - 1000)).toEqual({ value: 0, flags: ['AMOUNT_BELOW_CHARGE'] });
  });

  it('far away => 0, no flags', () => {
    expect(sig(20000)).toEqual({ value: 0, flags: [] });
  });

  it('pre-VAT interpretation: doc shows net, card charged gross => 0.90 * table, PRE_VAT_AMOUNT', () => {
    expect(sig(11500)).toEqual({ value: 0.9, flags: ['PRE_VAT_AMOUNT'] });
    expect(sig(11503)).toEqual({ value: 0.873, flags: ['PRE_VAT_AMOUNT'] });
  });

  it('does NOT stack the tip allowance on the pre-VAT reading (would widen the accepted range to ~1.38x)', () => {
    // doc 10000, charge 12000: direct is a 20% tip (0.40). A pre-VAT total + 4.3% tip would score 0.677,
    // but that stacked interpretation is deliberately not credited.
    expect(sig(12000)).toEqual({ value: 0.4, flags: ['TIP_SUSPECTED'] });
  });

  it('the pre-VAT flag is set only when that interpretation is the one that wins', () => {
    // direct tip 0.715 beats pre-VAT (below charge => 0)
    expect(sig(10600)).toEqual({ value: 0.715, flags: ['TIP_SUSPECTED'] });
    // exact direct match beats pre-VAT
    expect(sig(10000).flags).not.toContain('PRE_VAT_AMOUNT');
  });

  it('uses addVat rounding (half-up) for the gross amount', () => {
    // 12345 * 1.15 = 14196.75 -> 14197
    expect(amountSignal(14197, 12345, cfg)).toEqual({ value: 0.9, flags: ['PRE_VAT_AMOUNT'] });
  });

  it('respects the config instead of hardcoded numbers', () => {
    const c = { ...cfg, roundingTolMinor: 10, tipMaxRatio: 0.1 };
    expect(amountSignal(10010, 10000, c).value).toBe(0.97);
    expect(amountSignal(11001, 10000, c).value).toBe(0); // above 10% tip, and pre-VAT 11500 is below charge
  });
});

describe('dateSignal (calendar days in UTC+3)', () => {
  it.each([
    ['2026-10-04', '2026-10-04', 1, 0],
    ['2026-10-05', '2026-10-04', 0.8, 1],
    ['2026-10-06', '2026-10-04', 0.6, 2],
    ['2026-10-07', '2026-10-04', 0.4, 3],
  ])('txn %s, doc %s => %d (dd=%d)', (txnDay, docDay, value, dayDiff) => {
    const r = dateSignal(riyadhNoon(txnDay), docDay, cfg);
    expect(r.value).toBe(value);
    expect(r.dayDiff).toBe(dayDiff);
    expect(r.flags).toEqual(dayDiff === 0 ? [] : ['DATE_OFFSET']);
  });

  it('txn more than maxLagDays after the invoice => 0, no flags', () => {
    expect(dateSignal(riyadhNoon('2026-10-08'), '2026-10-04', cfg)).toEqual({ value: 0, dayDiff: 4, flags: [] });
  });

  it('invoice dated one day after the charge => 0.7 (DATE_OFFSET)', () => {
    expect(dateSignal(riyadhNoon('2026-10-03'), '2026-10-04', cfg)).toEqual({
      value: 0.7,
      dayDiff: -1,
      flags: ['DATE_OFFSET'],
    });
  });

  it('invoice dated two or more days after the charge => 0', () => {
    expect(dateSignal(riyadhNoon('2026-10-02'), '2026-10-04', cfg)).toEqual({ value: 0, dayDiff: -2, flags: [] });
  });

  it('missing date => 0.5 with DATE_MISSING and no day diff', () => {
    expect(dateSignal(riyadhNoon('2026-10-04'), null, cfg)).toEqual({ value: 0.5, dayDiff: null, flags: ['DATE_MISSING'] });
  });

  it('an impossible calendar date (2026-02-30) is treated as missing, not rolled over', () => {
    expect(dateSignal(riyadhNoon('2026-03-02'), '2026-02-30', cfg).flags).toEqual(['DATE_MISSING']);
  });

  it('day boundary uses Riyadh time, not UTC', () => {
    // 21:30Z on Oct 1 = 00:30 on Oct 2 in Riyadh
    expect(dateSignal(new Date('2026-10-01T21:30:00Z'), '2026-10-02', cfg).value).toBe(1);
    // 20:59:59Z on Oct 1 = 23:59:59 on Oct 1 in Riyadh
    expect(dateSignal(new Date('2026-10-01T20:59:59Z'), '2026-10-02', cfg)).toMatchObject({ value: 0.7, dayDiff: -1 });
    expect(dateSignal(new Date('2026-10-01T20:59:59Z'), '2026-10-01', cfg).value).toBe(1);
  });

  it('respects utcOffsetMinutes from config', () => {
    const utc = { ...cfg, utcOffsetMinutes: 0 };
    expect(dateSignal(new Date('2026-10-01T21:30:00Z'), '2026-10-02', utc)).toMatchObject({ value: 0.7, dayDiff: -1 });
  });

  it('an invalid Date on the transaction scores 0 rather than throwing', () => {
    expect(dateSignal(new Date('nope'), '2026-10-04', cfg).value).toBe(0);
  });
});

describe('cardSignal', () => {
  it('null when either side has no last4', () => {
    expect(cardSignal(null, '4242')).toEqual({ value: null, flags: [] });
    expect(cardSignal('4242', null)).toEqual({ value: null, flags: [] });
    expect(cardSignal(null, null)).toEqual({ value: null, flags: [] });
  });
  it('1 when equal', () => {
    expect(cardSignal('4242', '4242')).toEqual({ value: 1, flags: [] });
  });
  it('0 with CARD_MISMATCH when both known and different', () => {
    expect(cardSignal('4242', '9911')).toEqual({ value: 0, flags: ['CARD_MISMATCH'] });
  });
});

describe('merchantSignal', () => {
  it('is 0 when the document has no merchant name', () => {
    expect(merchantSignal(null, 'AL BAIK')).toBe(0);
  });
  it('is rounded to 4 decimals', () => {
    const v = merchantSignal('Starbucks', 'Starbuzz Cafe');
    expect(v).toBe(round4(v));
    expect(v).toBeLessThan(1);
  });
  it('is 1 for the same merchant spelled differently', () => {
    expect(merchantSignal('Starbucks Coffee Company', 'STARBUCKS #12345 RIYADH')).toBe(1);
  });
});
