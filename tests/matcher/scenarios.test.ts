import { matchDocument } from '@/lib/services/transaction-matcher';
import { SCENARIO_DOCS, SEEDED_TXNS, SENDERS, WA_SENDER, at, doc, txn, wa, PHONE } from './fixtures';

const run = (d: keyof typeof SCENARIO_DOCS, sender: (typeof SENDERS)[keyof typeof SENDERS]) =>
  matchDocument({ document: SCENARIO_DOCS[d], sender, candidates: SEEDED_TXNS });

const ids = (r: ReturnType<typeof matchDocument>) => r.candidates.map((c) => c.transactionId);

describe('seeded scenarios (mirror of SCENARIOS.md)', () => {
  it('exact: AUTO_MATCHED -> txn_exact', () => {
    const r = run('exact', SENDERS.alnoor_d1);
    expect(r).toMatchObject({ outcome: 'AUTO_MATCHED', reason: 'CLEAR_WINNER' });
    expect(ids(r)).toEqual(['txn_exact']);
    expect(r.candidates[0]).toMatchObject({ score: 0.9, flags: [], signals: { amount: 1, merchant: 1, date: 1, card: null } });
  });

  it('ambiguous: two txns tie at 0.90 -> NEEDS_REVIEW / AMBIGUOUS, both ranked, stable by id', () => {
    const r = run('ambiguous', SENDERS.alnoor_d1);
    expect(r).toMatchObject({ outcome: 'NEEDS_REVIEW', reason: 'AMBIGUOUS' });
    expect(r.candidates.map((c) => [c.transactionId, c.score])).toEqual([
      ['txn_amb_1', 0.9],
      ['txn_amb_2', 0.9],
    ]);
  });

  it('ambiguous_last4: matching last4 breaks the tie -> AUTO -> txn_amb_1; the mismatched sibling falls below the floor', () => {
    const r = run('ambiguous_last4', SENDERS.alnoor_d1);
    expect(r).toMatchObject({ outcome: 'AUTO_MATCHED', reason: 'CLEAR_WINNER' });
    expect(r.candidates.map((c) => [c.transactionId, c.score])).toEqual([['txn_amb_1', 1]]);
  });

  it('tip (10%): NEEDS_REVIEW / BELOW_AUTO_THRESHOLD -> txn_tip with TIP_SUSPECTED', () => {
    const r = run('tip', SENDERS.alnoor_d2);
    expect(r).toMatchObject({ outcome: 'NEEDS_REVIEW', reason: 'BELOW_AUTO_THRESHOLD' });
    expect(ids(r)[0]).toBe('txn_tip');
    expect(r.candidates[0]!.flags).toEqual(['TIP_SUSPECTED']);
    expect(r.candidates[0]!.score).toBeCloseTo(0.73125, 3);
    // Known leniency: PRE_VAT x TIP lets the unrelated txn_lowconf (7200) in as a weak runner-up (~0.5-0.6). It never threatens the winner.
    for (const weak of r.candidates.slice(1)) expect(r.candidates[0]!.score - weak.score).toBeGreaterThanOrEqual(0.1);
  });

  it('rounding (3 halalas): AUTO -> txn_round, no flags', () => {
    const r = run('rounding', SENDERS.alnoor_d2);
    expect(r).toMatchObject({ outcome: 'AUTO_MATCHED', reason: 'CLEAR_WINNER' });
    expect(r.candidates[0]).toMatchObject({ transactionId: 'txn_round', score: 0.8865, flags: [] });
  });

  it('prevat: AUTO -> txn_prevat with PRE_VAT_AMOUNT (0.855, just above the 0.85 threshold)', () => {
    const r = run('prevat', SENDERS.alnoor_d1);
    expect(r).toMatchObject({ outcome: 'AUTO_MATCHED', reason: 'CLEAR_WINNER' });
    expect(r.candidates[0]).toMatchObject({ transactionId: 'txn_prevat', score: 0.855, flags: ['PRE_VAT_AMOUNT'] });
  });

  it('no_transaction: UNMATCHED / NO_PLAUSIBLE_CANDIDATE, empty candidate list', () => {
    expect(run('no_transaction', SENDERS.alnoor_d1)).toEqual({ outcome: 'UNMATCHED', reason: 'NO_PLAUSIBLE_CANDIDATE', candidates: [] });
  });

  it('garbage: UNMATCHED / INSUFFICIENT_DATA', () => {
    expect(run('garbage', SENDERS.alnoor_d1)).toEqual({ outcome: 'UNMATCHED', reason: 'INSUFFICIENT_DATA', candidates: [] });
  });

  it('low_confidence: NEEDS_REVIEW / LOW_EXTRACTION_CONFIDENCE even though the match itself scores 0.90', () => {
    const r = run('low_confidence', SENDERS.alnoor_d2);
    expect(r).toMatchObject({ outcome: 'NEEDS_REVIEW', reason: 'LOW_EXTRACTION_CONFIDENCE' });
    expect(r.candidates[0]).toMatchObject({ transactionId: 'txn_lowconf', score: 0.9 });
  });

  it('email_exact: sent by the desert client -> AUTO -> txn_email', () => {
    const r = run('email_exact', SENDERS.desert_email);
    expect(r).toMatchObject({ outcome: 'AUTO_MATCHED', reason: 'CLEAR_WINNER' });
    expect(ids(r)).toEqual(['txn_email']);
  });

  it('arabic: Arabic merchant with branch noise matches the card-network name, by phone and by email', () => {
    for (const sender of [SENDERS.desert_d3, SENDERS.desert_email]) {
      const r = run('arabic', sender);
      expect(r).toMatchObject({ outcome: 'AUTO_MATCHED', reason: 'CLEAR_WINNER' });
      expect(r.candidates[0]).toMatchObject({ transactionId: 'txn_arabic', score: 0.9 });
    }
  });

  it('already_confirmed: txn_confirmed is excluded, nothing else is plausible -> UNMATCHED', () => {
    expect(run('already_confirmed', SENDERS.alnoor_d1)).toEqual({ outcome: 'UNMATCHED', reason: 'NO_PLAUSIBLE_CANDIDATE', candidates: [] });
  });

  it('already_confirmed proves the exclusion is what causes UNMATCHED: un-confirmed it would be an AUTO match', () => {
    const open = SEEDED_TXNS.map((t) => (t.id === 'txn_confirmed' ? { ...t, alreadyConfirmed: false } : t));
    const r = matchDocument({ document: SCENARIO_DOCS.already_confirmed, sender: SENDERS.alnoor_d1, candidates: open });
    expect(r).toMatchObject({ outcome: 'AUTO_MATCHED' });
    expect(ids(r)).toEqual(['txn_confirmed']);
  });
});

describe('the 6 required edge cases, plus tip vs last4 interplay', () => {
  it('3. tip with last4: a small tip (5%) auto-matches only when the card corroborates', () => {
    const base = { merchantName: 'Starbucks', amountMinor: 6000, documentDate: '2026-10-03' };
    const t = txn({ merchantName: 'STARBUCKS', amountMinor: 6300, occurredAt: at('2026-10-03'), cardLast4: '1111' });
    const without = matchDocument({ document: doc(base), sender: wa(PHONE), candidates: [t] });
    const withCard = matchDocument({ document: doc({ ...base, cardLast4: '1111' }), sender: wa(PHONE), candidates: [t] });
    expect(without).toMatchObject({ outcome: 'NEEDS_REVIEW', reason: 'BELOW_AUTO_THRESHOLD' });
    expect(withCard).toMatchObject({ outcome: 'AUTO_MATCHED' });
    expect(withCard.candidates[0]!.flags).toEqual(['TIP_SUSPECTED']);
  });

  it('3. a large tip (10%) still needs review even with a matching last4 (0.83 < 0.85): PLAN example only holds for tips <= ~8%', () => {
    const t = txn({ merchantName: 'STARBUCKS', amountMinor: 6600, occurredAt: at('2026-10-03'), cardLast4: '1111' });
    const r = matchDocument({
      document: doc({ merchantName: 'Starbucks', amountMinor: 6000, documentDate: '2026-10-03', cardLast4: '1111' }),
      sender: wa(PHONE),
      candidates: [t],
    });
    expect(r).toMatchObject({ outcome: 'NEEDS_REVIEW', reason: 'BELOW_AUTO_THRESHOLD' });
  });

  it('5. an invoice for a transaction that is not in the feed is UNMATCHED, not force-matched to the closest one', () => {
    const near = txn({ id: 'near', amountMinor: 4400 }); // 100 below the invoice: below-charge => amount 0
    const far = txn({ id: 'far', amountMinor: 90000 });
    const r = matchDocument({ document: doc(), sender: WA_SENDER, candidates: [near, far] });
    expect(r).toEqual({ outcome: 'UNMATCHED', reason: 'NO_PLAUSIBLE_CANDIDATE', candidates: [] });
  });
});
