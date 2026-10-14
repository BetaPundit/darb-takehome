import { DEFAULT_MATCHER_CONFIG as cfg, type MatcherConfig } from '@/lib/config/matching';
import { MAX_RESULT_CANDIDATES, matchDocument } from '@/lib/services/transaction-matcher';
import { WA_SENDER, at, doc, txn } from './fixtures';

const run = (document = doc(), candidates = [txn()], config: MatcherConfig = cfg) =>
  matchDocument({ document, sender: WA_SENDER, candidates, config });

const ids = (r: ReturnType<typeof matchDocument>) => r.candidates.map((c) => c.transactionId);

describe('autoThreshold boundary (scores are rounded to 4 decimals before comparing)', () => {
  // 0.35 + 0.3 + 0.2 === 0.8499999999999999 in IEEE-754. Rounded it is exactly 0.85.
  const weights = { amount: 0.35, merchant: 0.3, date: 0.2, card: 0.15 };

  it('score exactly equal to the threshold auto-matches (>=, and no float noise)', () => {
    expect(0.35 + 0.3 + 0.2).toBeLessThan(0.85);
    const r = run(doc(), [txn()], { ...cfg, weights, autoThreshold: 0.85 });
    expect(r.candidates[0]!.score).toBe(0.85);
    expect(r).toMatchObject({ outcome: 'AUTO_MATCHED', reason: 'CLEAR_WINNER' });
  });

  it('score just below the threshold goes to review', () => {
    const r = run(doc(), [txn()], { ...cfg, weights, autoThreshold: 0.8501 });
    expect(r).toMatchObject({ outcome: 'NEEDS_REVIEW', reason: 'BELOW_AUTO_THRESHOLD' });
  });

  it('default config: a date 3 days late (0.45 + 0.25 + 0.08 = 0.78) is below the auto threshold', () => {
    const justBelow = run(doc({ merchantName: 'Al Baik' }), [txn({ occurredAt: at('2026-10-05') })]); // dd=3 => 0.4 date: 0.45+0.25+0.08
    expect(justBelow.candidates[0]!.score).toBe(0.78);
    expect(justBelow.outcome).toBe('NEEDS_REVIEW');
  });
});

describe('minMargin boundary', () => {
  // top = 1.0, runner-up = 0.9, and 1 - 0.9 === 0.09999999999999998 in floats.
  const weights = { amount: 0.3, merchant: 0.2, date: 0.5, card: 0 };
  const candidates = [txn({ id: 'top' }), txn({ id: 'runner', occurredAt: at('2026-10-03') })];

  it('margin exactly equal to minMargin auto-matches', () => {
    expect(1 - 0.9).toBeLessThan(0.1);
    const r = run(doc(), candidates, { ...cfg, weights, minMargin: 0.1 });
    expect(r.candidates.map((c) => c.score)).toEqual([1, 0.9]);
    expect(r).toMatchObject({ outcome: 'AUTO_MATCHED', reason: 'CLEAR_WINNER' });
  });

  it('margin just below minMargin is AMBIGUOUS, and the runner-up is kept in the list', () => {
    const r = run(doc(), candidates, { ...cfg, weights, minMargin: 0.1001 });
    expect(r).toMatchObject({ outcome: 'NEEDS_REVIEW', reason: 'AMBIGUOUS' });
    expect(ids(r)).toEqual(['top', 'runner']);
  });

  it('a runner-up that is not plausible (below reviewFloor) does not make a match ambiguous', () => {
    const r = run(doc(), [txn({ id: 'top' }), txn({ id: 'junk', amountMinor: 99999 })]);
    expect(r).toMatchObject({ outcome: 'AUTO_MATCHED', reason: 'CLEAR_WINNER' });
    expect(ids(r)).toEqual(['top']);
  });
});

describe('reviewFloor boundary', () => {
  // amount exact (0.45) + merchant unknown (0) + invoice dated 1 day after the charge (0.2*0.7 = 0.13999999999999999)
  const document = doc({ merchantName: null, documentDate: '2026-10-03' });
  const candidates = [txn()]; // charged 2026-10-02

  it('score exactly equal to reviewFloor is plausible', () => {
    const r = run(document, candidates, { ...cfg, reviewFloor: 0.59 });
    expect(r.candidates[0]!.score).toBe(0.59);
    expect(r).toMatchObject({ outcome: 'NEEDS_REVIEW', reason: 'BELOW_AUTO_THRESHOLD' });
  });

  it('score just below reviewFloor is dropped => UNMATCHED / NO_PLAUSIBLE_CANDIDATE', () => {
    expect(run(document, candidates, { ...cfg, reviewFloor: 0.5901 })).toEqual({
      outcome: 'UNMATCHED',
      reason: 'NO_PLAUSIBLE_CANDIDATE',
      candidates: [],
    });
  });

  it('default floor: exact amount + a date 3 days late is plausible (0.53); 4 days late is not (0.45)', () => {
    const noMerchant = doc({ merchantName: null, documentDate: '2026-10-02' });
    expect(run(noMerchant, [txn({ occurredAt: at('2026-10-05') })]).candidates[0]!.score).toBe(0.53);
    expect(run(noMerchant, [txn({ occurredAt: at('2026-10-06') })]).outcome).toBe('UNMATCHED');
  });
});

describe('amount gate', () => {
  it('amount 0 but perfect merchant, date AND card must not reach reviewFloor (raw 0.55, capped to 0.49)', () => {
    const document = doc({ cardLast4: '4242' });
    const t = txn({ amountMinor: 99999, cardLast4: '4242' });
    expect(run(document, [t])).toEqual({ outcome: 'UNMATCHED', reason: 'NO_PLAUSIBLE_CANDIDATE', candidates: [] });
    // with the floor lowered so the capped candidate is visible
    const r = run(document, [t], { ...cfg, reviewFloor: 0 });
    expect(r.candidates[0]).toMatchObject({ score: 0.49, signals: { amount: 0, merchant: 1, date: 1, card: 1 } });
  });

  it('gate and cap come from config', () => {
    const r = run(doc({ cardLast4: '4242' }), [txn({ amountMinor: 99999, cardLast4: '4242' })], { ...cfg, reviewFloor: 0, gateCap: 0.2 });
    expect(r.candidates[0]!.score).toBe(0.2);
    // a tip signal (0.40) is above the default gate but below a stricter one (VAT off so the pre-VAT reading does not win)
    const noVat = { ...cfg, vatBps: 0 };
    const tip = txn({ amountMinor: 5400 }); // doc 4500: d=900 = tipMax => 0.40
    expect(run(doc(), [tip], noVat).candidates[0]!.signals.amount).toBe(0.4);
    expect(run(doc(), [tip], { ...noVat, amountGate: 0.5, gateCap: 0.3, reviewFloor: 0 }).candidates[0]!.score).toBe(0.3);
  });
});

describe('extraction confidence', () => {
  it('confidence exactly at minConfidenceForAuto may auto-match', () => {
    expect(run(doc({ confidence: 0.6 })).outcome).toBe('AUTO_MATCHED');
  });

  it('confidence just below caps at NEEDS_REVIEW / LOW_EXTRACTION_CONFIDENCE', () => {
    expect(run(doc({ confidence: 0.5999 }))).toMatchObject({ outcome: 'NEEDS_REVIEW', reason: 'LOW_EXTRACTION_CONFIDENCE' });
  });

  it('low confidence takes precedence over AMBIGUOUS in the reason', () => {
    const r = run(doc({ confidence: 0.3 }), [txn({ id: 'a' }), txn({ id: 'b' })]);
    expect(r).toMatchObject({ outcome: 'NEEDS_REVIEW', reason: 'LOW_EXTRACTION_CONFIDENCE' });
  });

  it('low confidence does not hide that nothing matched: still UNMATCHED', () => {
    expect(run(doc({ confidence: 0.3 }), [txn({ amountMinor: 99999 })]).outcome).toBe('UNMATCHED');
  });
});

describe('reason precedence among NEEDS_REVIEW', () => {
  it('AMBIGUOUS wins over BELOW_AUTO_THRESHOLD when two candidates tie below the threshold', () => {
    const r = run(doc({ merchantName: null }), [txn({ id: 'a' }), txn({ id: 'b' })]); // 0.45 + 0.2 = 0.65 each
    expect(r.candidates.map((c) => c.score)).toEqual([0.65, 0.65]);
    expect(r).toMatchObject({ outcome: 'NEEDS_REVIEW', reason: 'AMBIGUOUS' });
  });

  it('a single weak candidate is BELOW_AUTO_THRESHOLD, not AMBIGUOUS', () => {
    expect(run(doc({ merchantName: null }))).toMatchObject({ outcome: 'NEEDS_REVIEW', reason: 'BELOW_AUTO_THRESHOLD' });
  });
});

describe('date handling', () => {
  it('null document date can never auto-match, even with last4 corroboration (0.45+0.25+0.10+0.10 = 0.90)', () => {
    const r = run(doc({ documentDate: null, cardLast4: '4242' }), [txn({ cardLast4: '4242' })]);
    expect(r.candidates[0]).toMatchObject({ score: 0.9, flags: ['DATE_MISSING'] });
    expect(r).toMatchObject({ outcome: 'NEEDS_REVIEW', reason: 'BELOW_AUTO_THRESHOLD' });
  });

  it('null date without last4 peaks at 0.80', () => {
    expect(run(doc({ documentDate: null })).candidates[0]!.score).toBe(0.8);
  });

  it('a date far from the charge zeroes the date signal but the match can still be reviewed', () => {
    const r = run(doc(), [txn({ occurredAt: at('2026-10-20') })]);
    expect(r.candidates[0]).toMatchObject({ score: 0.7, signals: { date: 0 } });
    expect(r.outcome).toBe('NEEDS_REVIEW');
  });
});

describe('card signal', () => {
  it('matching last4 on both sides adds the 0.10 bonus', () => {
    expect(run(doc({ cardLast4: '4242' }), [txn({ cardLast4: '4242' })]).candidates[0]).toMatchObject({ score: 1, signals: { card: 1 } });
  });

  it('either side missing: card contributes 0 and is not renormalized', () => {
    expect(run(doc({ cardLast4: '4242' }), [txn()]).candidates[0]).toMatchObject({ score: 0.9, signals: { card: null } });
    expect(run(doc(), [txn({ cardLast4: '4242' })]).candidates[0]).toMatchObject({ score: 0.9, signals: { card: null } });
  });

  it('both known and different: CARD_MISMATCH halves the total (0.9 * 0.5 = 0.45, below the floor)', () => {
    const document = doc({ cardLast4: '4242' });
    const t = txn({ cardLast4: '9911' });
    expect(run(document, [t]).outcome).toBe('UNMATCHED');
    const r = run(document, [t], { ...cfg, reviewFloor: 0 });
    expect(r.candidates[0]).toMatchObject({ score: 0.45, flags: ['CARD_MISMATCH'], signals: { card: 0 } });
  });

  it('a card mismatch makes the other, uncontradicted candidate win decisively', () => {
    const r = run(doc({ cardLast4: '4242' }), [txn({ id: 'wrong', cardLast4: '9911' }), txn({ id: 'unknown' })]);
    expect(r).toMatchObject({ outcome: 'AUTO_MATCHED', reason: 'CLEAR_WINNER' });
    expect(ids(r)).toEqual(['unknown']);
  });
});

describe('amount flags flow into the result', () => {
  it('AMOUNT_BELOW_CHARGE, TIP_SUSPECTED and PRE_VAT_AMOUNT appear on the candidate', () => {
    const below = run(doc(), [txn({ amountMinor: 4400 })], { ...cfg, reviewFloor: 0 });
    expect(below.candidates[0]!.flags).toContain('AMOUNT_BELOW_CHARGE');
    expect(run(doc(), [txn({ amountMinor: 4800 })]).candidates[0]!.flags).toEqual(['TIP_SUSPECTED']);
    expect(run(doc(), [txn({ amountMinor: 5175 })]).candidates[0]!.flags).toEqual(['PRE_VAT_AMOUNT']);
  });

  it('DATE_OFFSET is reported when the dates differ but are within the window', () => {
    expect(run(doc(), [txn({ occurredAt: at('2026-10-03') })]).candidates[0]!.flags).toEqual(['DATE_OFFSET']);
  });
});

describe('result candidate list', () => {
  const many = Array.from({ length: 7 }, (_, i) => txn({ id: `t${i + 1}` }));

  it(`is capped at MAX_RESULT_CANDIDATES (${MAX_RESULT_CANDIDATES}) and keeps the best-ranked ones`, () => {
    expect(MAX_RESULT_CANDIDATES).toBe(5);
    const r = run(doc(), many);
    expect(ids(r)).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(r.reason).toBe('AMBIGUOUS');
  });

  it('contains only plausible candidates, ranked by score', () => {
    const r = run(doc(), [
      txn({ id: 'low', occurredAt: at('2026-10-05') }), // dd=3 => 0.78
      txn({ id: 'junk', amountMinor: 99999 }),
      txn({ id: 'best' }), // 0.9
    ]);
    expect(r.candidates.map((c) => [c.transactionId, c.score])).toEqual([
      ['best', 0.9],
      ['low', 0.78],
    ]);
  });

  it('every score and signal is rounded to at most 4 decimals', () => {
    const r = run(doc({ merchantName: 'Starbucks' }), [txn({ merchantName: 'Starbuzz Cafe', amountMinor: 4523 })], { ...cfg, reviewFloor: 0 });
    const c = r.candidates[0]!;
    for (const v of [c.score, c.signals.amount, c.signals.merchant, c.signals.date]) {
      expect(v).toBe(Math.round(v * 10000) / 10000);
    }
  });
});
