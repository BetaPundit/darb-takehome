import { matchDocument } from '@/lib/services/transaction-matcher';
import { PHONE, SCENARIO_DOCS, SEEDED_TXNS, SENDERS, doc, email, txn, wa } from './fixtures';

const WA = wa(PHONE);
const NO_CANDIDATES = { outcome: 'UNMATCHED', reason: 'NO_CANDIDATES_IN_SCOPE', candidates: [] } as const;

describe('usable-document gate', () => {
  it.each([
    ['UNKNOWN document type', { documentType: 'UNKNOWN' as const }],
    ['null amount', { totalAmount: null }],
    ['null currency', { currency: null }],
    ['zero amount', { totalAmount: 0 }],
  ])('%s => UNMATCHED / INSUFFICIENT_DATA, even if every other field is perfect', (_name, overrides) => {
    const r = matchDocument({ document: doc(overrides), sender: WA, candidates: [txn()] });
    expect(r).toEqual({ outcome: 'UNMATCHED', reason: 'INSUFFICIENT_DATA', candidates: [] });
  });

  it('a document with no merchant, no date and no card is still usable (amount + currency are enough to score)', () => {
    const r = matchDocument({ document: doc({ merchantName: null, documentDate: null }), sender: WA, candidates: [txn()] });
    expect(r.reason).not.toBe('INSUFFICIENT_DATA');
    expect(r.candidates).toHaveLength(1);
  });
});

describe('hard filters', () => {
  it('no candidates at all => NO_CANDIDATES_IN_SCOPE', () => {
    expect(matchDocument({ document: doc(), sender: WA, candidates: [] })).toEqual(NO_CANDIDATES);
  });

  it('a transaction that already has a confirmed match is excluded, however good the match', () => {
    const r = matchDocument({ document: doc(), sender: WA, candidates: [txn({ alreadyConfirmed: true })] });
    expect(r).toEqual(NO_CANDIDATES);
  });

  it('a confirmed transaction does not stop the open twin from matching, and does not count as runner-up', () => {
    const r = matchDocument({
      document: doc(),
      sender: WA,
      candidates: [txn({ id: 'a', alreadyConfirmed: true }), txn({ id: 'b' })],
    });
    expect(r).toMatchObject({ outcome: 'AUTO_MATCHED', reason: 'CLEAR_WINNER' });
    expect(r.candidates.map((c) => c.transactionId)).toEqual(['b']);
  });

  it('currency mismatch is a hard filter even when the numbers are identical', () => {
    expect(matchDocument({ document: doc(), sender: WA, candidates: [txn({ currency: 'USD' })] })).toEqual(NO_CANDIDATES);
  });

  it('currency comparison ignores case', () => {
    const r = matchDocument({ document: doc({ currency: 'sar' }), sender: WA, candidates: [txn()] });
    expect(r.outcome).toBe('AUTO_MATCHED');
  });
});

describe('scope filter: WHATSAPP (driverPhone must equal the sender phone)', () => {
  it('right driver matches', () => {
    expect(matchDocument({ document: doc(), sender: WA, candidates: [txn()] }).outcome).toBe('AUTO_MATCHED');
  });

  it('wrong driver of the SAME client does not match', () => {
    const r = matchDocument({ document: doc(), sender: wa('+966509999999'), candidates: [txn()] });
    expect(r).toEqual(NO_CANDIDATES);
  });

  it('a transaction without a driverPhone is never in scope for WhatsApp', () => {
    expect(matchDocument({ document: doc(), sender: WA, candidates: [txn({ driverPhone: null })] })).toEqual(NO_CANDIDATES);
  });

  it('phone comparison is strict: the caller must pass E.164 (fail closed, never a wrong-scope match)', () => {
    expect(matchDocument({ document: doc(), sender: wa('0500000001'), candidates: [txn()] })).toEqual(NO_CANDIDATES);
  });

  it('seeded: a driver of another client cannot claim a perfect match for someone else', () => {
    const r = matchDocument({ document: SCENARIO_DOCS.exact, sender: SENDERS.desert_d3, candidates: SEEDED_TXNS });
    expect(r).toMatchObject({ outcome: 'UNMATCHED', reason: 'NO_PLAUSIBLE_CANDIDATE' });
  });

  it('seeded: a sibling driver of the same client cannot claim a colleague\'s transaction', () => {
    const r = matchDocument({ document: SCENARIO_DOCS.exact, sender: SENDERS.alnoor_d2, candidates: SEEDED_TXNS });
    expect(r.outcome).not.toBe('AUTO_MATCHED');
    expect(r.candidates.map((c) => c.transactionId)).not.toContain('txn_exact');
  });
});

describe('scope filter: EMAIL (clientId must equal the sender client)', () => {
  it('right client matches regardless of which driver made the purchase', () => {
    const r = matchDocument({ document: doc(), sender: email('c1'), candidates: [txn({ driverPhone: '+966507777777' })] });
    expect(r.outcome).toBe('AUTO_MATCHED');
  });

  it('a transaction without a driverPhone is in scope for email (client-level card)', () => {
    expect(matchDocument({ document: doc(), sender: email('c1'), candidates: [txn({ driverPhone: null })] }).outcome).toBe('AUTO_MATCHED');
  });

  it('wrong client does not match', () => {
    expect(matchDocument({ document: doc(), sender: email('c2'), candidates: [txn()] })).toEqual(NO_CANDIDATES);
  });

  it('seeded: the other client\'s ADNOC invoice does not match alnoor transactions and vice versa', () => {
    const r = matchDocument({ document: SCENARIO_DOCS.email_exact, sender: SENDERS.alnoor_email, candidates: SEEDED_TXNS });
    expect(r).toMatchObject({ outcome: 'UNMATCHED', reason: 'NO_PLAUSIBLE_CANDIDATE' });
  });

  it('out-of-scope twins never become runner-ups: they cannot create AMBIGUOUS', () => {
    const r = matchDocument({
      document: doc(),
      sender: email('c1'),
      candidates: [txn({ id: 'mine' }), txn({ id: 'theirs', clientId: 'c2' })],
    });
    expect(r).toMatchObject({ outcome: 'AUTO_MATCHED', reason: 'CLEAR_WINNER' });
    expect(r.candidates.map((c) => c.transactionId)).toEqual(['mine']);
  });
});
