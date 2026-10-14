import { amountEvidence, cardEvidence, dateEvidence, formatDocumentDate, merchantEvidence, ocrConfidence } from '@/app/review/_components/evidence';

// Riyadh is UTC+3: 2026-10-03T05:05Z is 08:05 on 3 Oct.
const charge = new Date('2026-10-03T05:05:00Z');

describe('amountEvidence', () => {
  const txn = (amountMinor: number) => ({ amountMinor, currency: 'SAR' });

  it('same amount', () => {
    expect(amountEvidence(6000, txn(6000), [])).toMatchObject({ tone: 'good', value: '60.00 SAR', note: 'Same as the receipt' });
  });
  it('rounding difference (within 5 halalas) still counts as a match and says so', () => {
    expect(amountEvidence(23100, txn(23103), [])).toMatchObject({ tone: 'good', note: 'Off by 0.03 SAR (rounding)' });
  });
  it('a larger charge is a partial match that names the difference and its size', () => {
    expect(amountEvidence(6000, txn(6600), ['TIP_SUSPECTED'])).toMatchObject({ tone: 'partial', note: '6.00 SAR (10%) more than the receipt, maybe a tip' });
  });
  it('a larger charge without the tip flag does not guess a tip', () => {
    expect(amountEvidence(6000, txn(6600), []).note).toBe('6.00 SAR (10%) more than the receipt');
  });
  it('a smaller charge is a mismatch', () => {
    expect(amountEvidence(6000, txn(5800), ['AMOUNT_BELOW_CHARGE'])).toMatchObject({ tone: 'bad', note: '2.00 SAR less than the receipt' });
  });
  it('pre-VAT receipt', () => {
    expect(amountEvidence(10000, txn(11500), ['PRE_VAT_AMOUNT'])).toMatchObject({ tone: 'partial', note: 'Receipt amount plus 15% VAT' });
  });
  it('no amount on the receipt is unknown, never a mismatch', () => {
    expect(amountEvidence(null, txn(6000), [])).toMatchObject({ tone: 'unknown', note: 'No amount on the receipt' });
  });
});

describe('dateEvidence', () => {
  it('same calendar day in Riyadh, whatever the time', () => {
    expect(dateEvidence('2026-10-03', charge)).toMatchObject({ tone: 'good', value: '3 Oct, 08:05', note: 'Same day' });
  });
  it('a datetime with an offset is compared by its Riyadh day', () => {
    // 22:30Z on 2 Oct is 01:30 on 3 Oct in Riyadh: same day as the charge
    expect(dateEvidence('2026-10-02T22:30:00Z', charge).note).toBe('Same day');
  });
  it('charged after the receipt date', () => {
    expect(dateEvidence('2026-10-01', charge)).toMatchObject({ tone: 'partial', note: 'Charged 2 days after the receipt date' });
    expect(dateEvidence('2026-10-02', charge).note).toBe('Charged 1 day after the receipt date');
  });
  it('receipt dated after the charge', () => {
    expect(dateEvidence('2026-10-04', charge)).toMatchObject({ tone: 'partial', note: 'Receipt is dated 1 day after the charge' });
  });
  it('far apart is a mismatch', () => {
    expect(dateEvidence('2026-09-01', charge)).toMatchObject({ tone: 'bad', note: '32 days apart' });
  });
  it('missing or invalid receipt date is unknown', () => {
    expect(dateEvidence(null, charge)).toMatchObject({ tone: 'unknown', note: 'No date on the receipt' });
    expect(dateEvidence('2026-02-30', charge).tone).toBe('unknown');
  });
});

describe('merchantEvidence', () => {
  it.each([
    [1, 'good', 'Same name'],
    [0.93, 'good', 'Same name'],
    [0.75, 'partial', 'Similar name'],
    [0.2, 'bad', 'Different name'],
  ] as const)('similarity %s is %s', (s, tone, value) => {
    expect(merchantEvidence(s)).toMatchObject({ tone, value, note: `${Math.round(s * 100)}% match` });
  });
  it('unknown similarity (unreadable stored signals) is unknown', () => {
    expect(merchantEvidence(null)).toMatchObject({ tone: 'unknown' });
  });
});

describe('cardEvidence', () => {
  it('same last 4', () => {
    expect(cardEvidence('4242', '4242')).toMatchObject({ tone: 'good', value: '•••• 4242', note: 'Same card' });
  });
  it('different last 4 says both', () => {
    expect(cardEvidence('4242', '9911')).toMatchObject({ tone: 'bad', value: '•••• 9911', note: 'Receipt shows •••• 4242' });
  });
  it('no card on the receipt is unknown, not a mismatch', () => {
    expect(cardEvidence(null, '9911')).toMatchObject({ tone: 'unknown', note: 'No card number on the receipt' });
  });
  it('no card on the transaction is unknown', () => {
    expect(cardEvidence('4242', null)).toMatchObject({ tone: 'unknown', note: 'Transaction has no card number' });
  });
});

describe('ocrConfidence', () => {
  it('flags confidence below the auto-match bar (0.60) as low', () => {
    expect(ocrConfidence(0.45)).toEqual({ percent: 45, low: true });
    expect(ocrConfidence(0.6)).toEqual({ percent: 60, low: false });
  });
});

describe('formatDocumentDate', () => {
  it('shows a plain date as that calendar day', () => {
    expect(formatDocumentDate('2026-10-03')).toBe('3 Oct 2026');
  });
  it('shows a datetime as its Riyadh calendar day', () => {
    expect(formatDocumentDate('2026-10-02T22:30:00Z')).toBe('3 Oct 2026');
  });
  it('says so when there is no usable date', () => {
    expect(formatDocumentDate(null)).toBe('No date');
    expect(formatDocumentDate('2026-02-30')).toBe('No date');
  });
});
