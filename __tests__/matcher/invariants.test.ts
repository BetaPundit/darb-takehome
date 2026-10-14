import { DEFAULT_MATCHER_CONFIG as cfg } from '@/lib/config/matching';
import { matchDocument } from '@/lib/services/transaction-matcher';
import { SCENARIO_DOCS, SEEDED_TXNS, SENDERS, WA_SENDER, at, deepFreeze, doc, shuffled, txn } from './fixtures';

describe('order independence', () => {
  it('every seeded scenario gives an identical result for 30 random candidate orders', () => {
    const cases = [
      ['exact', SENDERS.alnoor_d1], ['ambiguous', SENDERS.alnoor_d1], ['ambiguous_last4', SENDERS.alnoor_d1],
      ['tip', SENDERS.alnoor_d2], ['rounding', SENDERS.alnoor_d2], ['prevat', SENDERS.alnoor_d1],
      ['no_transaction', SENDERS.alnoor_email], ['low_confidence', SENDERS.alnoor_email], ['email_exact', SENDERS.desert_email],
      ['arabic', SENDERS.desert_email], ['already_confirmed', SENDERS.alnoor_email],
    ] as const;
    for (const [name, sender] of cases) {
      const baseline = matchDocument({ document: SCENARIO_DOCS[name], sender, candidates: SEEDED_TXNS });
      for (let seed = 1; seed <= 30; seed++) {
        const r = matchDocument({ document: SCENARIO_DOCS[name], sender, candidates: shuffled(SEEDED_TXNS, seed) });
        expect(r).toEqual(baseline);
      }
    }
  });

  it('exact ties are broken by id, regardless of input order, and the cap keeps the same five', () => {
    const tied = Array.from({ length: 8 }, (_, i) => txn({ id: `t${i + 1}` }));
    for (let seed = 1; seed <= 30; seed++) {
      const r = matchDocument({ document: doc(), sender: WA_SENDER, candidates: shuffled(tied, seed) });
      expect(r.candidates.map((c) => c.transactionId)).toEqual(['t1', 't2', 't3', 't4', 't5']);
    }
  });

  it('equal scores: the smaller |dayDiff| ranks first, before the id tiebreak', () => {
    // 2 days late: date 1 - 0.15*2 = 0.70; one day early: leadSignal 0.70. Equal scores (0.45+0.25+0.14), |dd| 2 vs 1.
    const config = { ...cfg, lagDecayPerDay: 0.15 };
    const late = txn({ id: 'a_late', occurredAt: at('2026-10-04') });
    const early = txn({ id: 'z_early', occurredAt: at('2026-10-01') });
    for (const order of [[late, early], [early, late]]) {
      const r = matchDocument({ document: doc(), sender: WA_SENDER, candidates: order, config });
      expect(r.candidates.map((c) => [c.transactionId, c.score])).toEqual([['z_early', 0.84], ['a_late', 0.84]]);
    }
  });
});

describe('purity', () => {
  it('does not mutate frozen inputs (frozen objects throw on write in strict mode) and does not alias them in the output', () => {
    const input = deepFreeze({
      document: doc({ cardLast4: '4242' }),
      sender: { kind: 'WHATSAPP' as const, phone: '+966500000001' },
      candidates: [txn({ id: 'a', cardLast4: '4242' }), txn({ id: 'b' })],
      config: { ...cfg, weights: { ...cfg.weights } },
    });
    const before = JSON.stringify(input);
    const r = matchDocument(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(Object.isFrozen(r.candidates)).toBe(false);
  });

  it('is deterministic and never reads the clock or randomness', () => {
    const now = jest.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Date.now called');
    });
    const rnd = jest.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random called');
    });
    try {
      const a = matchDocument({ document: SCENARIO_DOCS.ambiguous, sender: SENDERS.alnoor_d1, candidates: SEEDED_TXNS });
      const b = matchDocument({ document: SCENARIO_DOCS.ambiguous, sender: SENDERS.alnoor_d1, candidates: SEEDED_TXNS });
      expect(a).toEqual(b);
    } finally {
      now.mockRestore();
      rnd.mockRestore();
    }
  });

  it('uses DEFAULT_MATCHER_CONFIG when no config is passed', () => {
    const input = { document: doc(), sender: WA_SENDER, candidates: [txn()] };
    expect(matchDocument(input)).toEqual(matchDocument({ ...input, config: cfg }));
  });
});

describe('adversarial documents (limits of what a crafted receipt can do)', () => {
  it('an invoice claiming a merchant name from a different transaction cannot steal it without matching the amount', () => {
    const victim = txn({ id: 'victim', merchantName: 'ARAMCO RETAIL 0412', amountMinor: 18750 });
    const r = matchDocument({
      document: doc({ merchantName: 'Aramco Retail', amountMinor: 100, documentDate: '2026-10-02' }),
      sender: WA_SENDER,
      candidates: [victim],
    });
    expect(r.outcome).toBe('UNMATCHED');
  });

  it('an invoice with the right amount but a nonsense merchant and date is capped below AUTO', () => {
    const r = matchDocument({
      document: doc({ merchantName: 'Totally Different Ltd', documentDate: '2026-09-01' }),
      sender: WA_SENDER,
      candidates: [txn()],
    });
    expect(r.outcome).not.toBe('AUTO_MATCHED');
  });

  it('a single-generic-token merchant ("Retail") subsets a longer name: bounded by amount/date, still requires them to line up', () => {
    const t = txn({ merchantName: 'ARAMCO RETAIL 0412' });
    const r = matchDocument({ document: doc({ merchantName: 'Retail' }), sender: WA_SENDER, candidates: [t] });
    expect(r.candidates[0]!.signals.merchant).toBe(1); // documented weakness of the subset rule
    const wrongAmount = matchDocument({ document: doc({ merchantName: 'Retail', amountMinor: 1 }), sender: WA_SENDER, candidates: [t] });
    expect(wrongAmount.outcome).toBe('UNMATCHED');
  });
});

describe('documented limitation: cross-script merchant names', () => {
  it('Arabic "مكتبة جرير" vs English "JARIR BOOKSTORE": merchant signal is ~0, so an otherwise perfect match is only reviewable, never AUTO', () => {
    const r = matchDocument({
      document: doc({ merchantName: 'مكتبة جرير', amountMinor: 11500 }),
      sender: WA_SENDER,
      candidates: [txn({ merchantName: 'JARIR BOOKSTORE', amountMinor: 11500 })],
    });
    expect(r.candidates[0]!.signals.merchant).toBeLessThan(0.3);
    expect(r.outcome).toBe('NEEDS_REVIEW'); // 0.45 + ~0 + 0.20 = 0.65
  });
});
