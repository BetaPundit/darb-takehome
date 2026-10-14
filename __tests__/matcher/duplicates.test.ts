import { DEFAULT_MATCHER_CONFIG as cfg } from '@/lib/config/matching';
import { matchDocument } from '@/lib/services/transaction-matcher';
import { SCENARIO_DOCS, SEEDED_TXNS, SENDERS, WA_SENDER, at, doc, shuffled, txn } from './fixtures';

/**
 * A transaction that already has a CONFIRMED / AUTO_CONFIRMED document is still scored (and flagged ALREADY_CONFIRMED),
 * but it can never be auto-matched again: the document goes to review as a possible duplicate receipt.
 */
const run = (document = doc(), candidates = [txn()], config = cfg) => matchDocument({ document, sender: WA_SENDER, candidates, config });
const ids = (r: ReturnType<typeof matchDocument>) => r.candidates.map((c) => c.transactionId);
const flagged = (r: ReturnType<typeof matchDocument>) => r.candidates.filter((c) => c.flags.includes('ALREADY_CONFIRMED')).map((c) => c.transactionId);

describe('a confirmed transaction is scored normally, flagged, and never auto-matched', () => {
  it('a perfect match on a confirmed transaction => NEEDS_REVIEW / POSSIBLE_DUPLICATE (not UNMATCHED, not AUTO)', () => {
    const r = run(doc(), [txn({ alreadyConfirmed: true })]);
    expect(r).toMatchObject({ outcome: 'NEEDS_REVIEW', reason: 'POSSIBLE_DUPLICATE' });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ transactionId: 't1', score: 0.9, flags: ['ALREADY_CONFIRMED'], signals: { amount: 1, merchant: 1, date: 1, card: null } });
  });

  it('the score is exactly what the same transaction would get unconfirmed: the flag changes the route, not the number', () => {
    const open = run(doc(), [txn()]);
    const confirmed = run(doc(), [txn({ alreadyConfirmed: true })]);
    expect(open).toMatchObject({ outcome: 'AUTO_MATCHED' });
    expect(confirmed.candidates[0]!.score).toBe(open.candidates[0]!.score);
    expect(confirmed.candidates[0]!.signals).toEqual(open.candidates[0]!.signals);
  });

  it('even a 1.00 match (card corroborates) on a confirmed transaction goes to review', () => {
    const r = run(doc({ cardLast4: '4242' }), [txn({ cardLast4: '4242', alreadyConfirmed: true })]);
    expect(r.candidates[0]!.score).toBe(1);
    expect(r).toMatchObject({ outcome: 'NEEDS_REVIEW', reason: 'POSSIBLE_DUPLICATE' });
  });

  it('the flag is appended after the signal flags', () => {
    const r = run(doc({ totalAmount: 4000 }), [txn({ alreadyConfirmed: true })]); // charge 45.00 vs invoice 40.00: tip-sized
    expect(r.candidates[0]!.flags).toEqual(['TIP_SUSPECTED', 'ALREADY_CONFIRMED']);
  });

  it('an unconfirmed transaction never carries the flag', () => {
    expect(run().candidates.flatMap((c) => c.flags)).not.toContain('ALREADY_CONFIRMED');
  });

  it('the other hard filters still apply to confirmed transactions: another driver\'s or another currency\'s is not offered (no leak)', () => {
    expect(run(doc(), [txn({ alreadyConfirmed: true, driverPhone: '+966509999999' })])).toEqual({ outcome: 'UNMATCHED', reason: 'NO_CANDIDATES_IN_SCOPE', candidates: [] });
    expect(run(doc(), [txn({ alreadyConfirmed: true, currency: 'USD' })])).toEqual({ outcome: 'UNMATCHED', reason: 'NO_CANDIDATES_IN_SCOPE', candidates: [] });
    const email = matchDocument({ document: doc(), sender: { kind: 'EMAIL', clientId: 'c2' }, candidates: [txn({ alreadyConfirmed: true })] });
    expect(email).toEqual({ outcome: 'UNMATCHED', reason: 'NO_CANDIDATES_IN_SCOPE', candidates: [] });
  });

  it('a confirmed transaction that is not a plausible match (wrong amount) is dropped like any other: no review noise', () => {
    expect(run(doc({ totalAmount: 99900 }), [txn({ alreadyConfirmed: true })])).toEqual({ outcome: 'UNMATCHED', reason: 'NO_PLAUSIBLE_CANDIDATE', candidates: [] });
  });

  it('with every candidate confirmed, no document in the scenario set can be auto-matched, whoever sends it', () => {
    const allConfirmed = SEEDED_TXNS.map((t) => ({ ...t, alreadyConfirmed: true }));
    for (const [name, document] of Object.entries(SCENARIO_DOCS)) {
      for (const [who, sender] of Object.entries(SENDERS)) {
        const r = matchDocument({ document, sender, candidates: allConfirmed });
        expect([name, who, r.outcome]).not.toContain('AUTO_MATCHED');
        if (r.outcome === 'NEEDS_REVIEW') expect(r.candidates.every((c) => c.flags.includes('ALREADY_CONFIRMED'))).toBe(true);
      }
    }
  });
});

describe('ranking: at equal score an unconfirmed candidate sorts before a confirmed one', () => {
  it('whatever the input order and the ids (the confirmed one has the smaller id)', () => {
    const confirmed = txn({ id: 'a', alreadyConfirmed: true });
    const open = txn({ id: 'b' });
    for (let seed = 1; seed <= 20; seed++) {
      const r = run(doc(), shuffled([confirmed, open], seed));
      expect(ids(r)).toEqual(['b', 'a']);
    }
  });

  it('it comes before the day-difference tiebreak too', () => {
    // 2 days late: date 1 - 0.15*2 = 0.70; one day early: leadSignal 0.70. Equal scores; the early one is closer (|dd| 1 vs 2).
    const config = { ...cfg, lagDecayPerDay: 0.15 };
    const confirmedEarly = txn({ id: 'a_early', occurredAt: at('2026-10-01'), alreadyConfirmed: true });
    const openLate = txn({ id: 'z_late', occurredAt: at('2026-10-04') });
    const unconfirmedFirst = run(doc(), [confirmedEarly, openLate], config);
    expect(unconfirmedFirst.candidates.map((c) => [c.transactionId, c.score])).toEqual([['z_late', 0.84], ['a_early', 0.84]]);
    // control: with both unconfirmed the closer day wins, so it really is the flag that reordered them
    const control = run(doc(), [{ ...confirmedEarly, alreadyConfirmed: false }, openLate], config);
    expect(ids(control)).toEqual(['a_early', 'z_late']);
  });

  it('it never overrides the score: a better-scoring confirmed transaction still ranks first', () => {
    const better = txn({ id: 'z_confirmed', alreadyConfirmed: true });
    const worse = txn({ id: 'a_open', occurredAt: at('2026-10-03') }); // one day after the document: date 0.8
    const r = run(doc(), [worse, better]);
    expect(ids(r)).toEqual(['z_confirmed', 'a_open']);
    expect(r).toMatchObject({ outcome: 'NEEDS_REVIEW', reason: 'POSSIBLE_DUPLICATE' }); // top is the confirmed one
  });
});

describe('an unconfirmed top candidate next to a confirmed runner-up', () => {
  it('still auto-matches when it clears the threshold with the required margin (the margin rule covers the runner-up)', () => {
    const open = txn({ id: 'open' });
    const confirmedLate = txn({ id: 'confirmed', occurredAt: at('2026-10-05'), alreadyConfirmed: true }); // 3 days late: 0.78
    const r = run(doc(), [confirmedLate, open]);
    expect(r.candidates.map((c) => [c.transactionId, c.score])).toEqual([['open', 0.9], ['confirmed', 0.78]]);
    expect(r).toMatchObject({ outcome: 'AUTO_MATCHED', reason: 'CLEAR_WINNER' });
    expect(flagged(r)).toEqual(['confirmed']); // kept (and flagged) for the audit trail
  });

  it('an identical confirmed twin makes it AMBIGUOUS, not POSSIBLE_DUPLICATE: the top is not the duplicate', () => {
    // A resent copy of receipt 1 looks exactly like receipt 2 of an identical purchase, so elimination is not safe.
    const r = run(doc(), [txn({ id: 'a', alreadyConfirmed: true }), txn({ id: 'b' })]);
    expect(r).toMatchObject({ outcome: 'NEEDS_REVIEW', reason: 'AMBIGUOUS' });
    expect(ids(r)).toEqual(['b', 'a']);
    expect(flagged(r)).toEqual(['a']);
  });

  it('a confirmed runner-up inside the margin blocks auto-match exactly like an unconfirmed one (margin 0.08 < 0.10)', () => {
    const r = run(doc(), [txn({ id: 'open' }), txn({ id: 'confirmed', occurredAt: at('2026-10-04'), alreadyConfirmed: true })]); // 2 days late: 0.82
    expect(r.candidates.map((c) => c.score)).toEqual([0.9, 0.82]);
    expect(r).toMatchObject({ outcome: 'NEEDS_REVIEW', reason: 'AMBIGUOUS' });
  });
});

describe('reason precedence when the top candidate is confirmed: LOW_EXTRACTION_CONFIDENCE, POSSIBLE_DUPLICATE, AMBIGUOUS, BELOW_AUTO_THRESHOLD', () => {
  it('POSSIBLE_DUPLICATE beats AMBIGUOUS: confirmed top within the margin of an unconfirmed runner-up', () => {
    const r = run(doc(), [txn({ id: 'a', alreadyConfirmed: true }), txn({ id: 'b', occurredAt: at('2026-10-03') })]); // runner-up 0.82? one day AFTER the document: date 0.70 -> 0.84
    expect(r.candidates.map((c) => c.transactionId)).toEqual(['a', 'b']);
    expect(r.candidates[0]!.score - r.candidates[1]!.score).toBeLessThan(cfg.minMargin);
    expect(r).toMatchObject({ outcome: 'NEEDS_REVIEW', reason: 'POSSIBLE_DUPLICATE' });
  });

  it('POSSIBLE_DUPLICATE beats BELOW_AUTO_THRESHOLD: a confirmed top that is also only a tip-sized match', () => {
    const r = run(doc({ totalAmount: 4000 }), [txn({ alreadyConfirmed: true })]);
    expect(r.candidates[0]!.score).toBeLessThan(cfg.autoThreshold);
    expect(r).toMatchObject({ outcome: 'NEEDS_REVIEW', reason: 'POSSIBLE_DUPLICATE' });
  });

  it('LOW_EXTRACTION_CONFIDENCE keeps precedence: an unreadable document says so first (the duplicate flag is still on the candidate)', () => {
    const r = run(doc({ extractionConfidence: 0.4 }), [txn({ alreadyConfirmed: true })]);
    expect(r).toMatchObject({ outcome: 'NEEDS_REVIEW', reason: 'LOW_EXTRACTION_CONFIDENCE' });
    expect(flagged(r)).toEqual(['t1']);
  });

  it('a missing date does not turn a confirmed top into anything but POSSIBLE_DUPLICATE', () => {
    const r = run(doc({ documentDate: null }), [txn({ alreadyConfirmed: true })]);
    expect(r).toMatchObject({ outcome: 'NEEDS_REVIEW', reason: 'POSSIBLE_DUPLICATE' });
  });
});

describe('seeded scenarios', () => {
  it('already_confirmed (the SASCO receipt, txn_confirmed already holds a confirmed document) => NEEDS_REVIEW / POSSIBLE_DUPLICATE, flagged', () => {
    const r = matchDocument({ document: SCENARIO_DOCS.already_confirmed, sender: SENDERS.alnoor_d1, candidates: SEEDED_TXNS });
    expect(r).toMatchObject({ outcome: 'NEEDS_REVIEW', reason: 'POSSIBLE_DUPLICATE' });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ transactionId: 'txn_confirmed', score: 0.9, flags: ['ALREADY_CONFIRMED'] });
  });

  it('cross-channel duplicate: the `exact` receipt sent again by email once txn_exact is confirmed => NEEDS_REVIEW / POSSIBLE_DUPLICATE', () => {
    const afterFirstCopy = SEEDED_TXNS.map((t) => (t.id === 'txn_exact' ? { ...t, alreadyConfirmed: true } : t));
    const r = matchDocument({ document: SCENARIO_DOCS.exact, sender: SENDERS.alnoor_email, candidates: afterFirstCopy });
    expect(r).toMatchObject({ outcome: 'NEEDS_REVIEW', reason: 'POSSIBLE_DUPLICATE' });
    expect(r.candidates[0]).toMatchObject({ transactionId: 'txn_exact', flags: ['ALREADY_CONFIRMED'] });
  });

  it('un-confirmed, the same document is an AUTO match: the flag is the only difference', () => {
    const open = SEEDED_TXNS.map((t) => (t.id === 'txn_confirmed' ? { ...t, alreadyConfirmed: false } : t));
    const r = matchDocument({ document: SCENARIO_DOCS.already_confirmed, sender: SENDERS.alnoor_d1, candidates: open });
    expect(r).toMatchObject({ outcome: 'AUTO_MATCHED' });
    expect(ids(r)).toEqual(['txn_confirmed']);
  });
});
