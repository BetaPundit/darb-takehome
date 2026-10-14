import type { MatchFlag } from '@/lib/matching/signals';
import type { MatchReason } from '@/lib/services/transaction-matcher';
import { flagLabel, flagText, reasonText } from '@/app/review/_components/labels';

// Typed as the full unions, so adding a flag or a reason without a label here is a compile error, and a label
// that is still missing makes the test fail (an unknown code falls back to the raw code, which is never what a reviewer should read).
const FLAGS: Record<MatchFlag, true> = {
  TIP_SUSPECTED: true, PRE_VAT_AMOUNT: true, CARD_MISMATCH: true, DATE_MISSING: true, DATE_OFFSET: true, AMOUNT_BELOW_CHARGE: true, ALREADY_CONFIRMED: true,
};
const MATCHER_REASONS: Record<MatchReason, true> = {
  INSUFFICIENT_DATA: true, NO_CANDIDATES_IN_SCOPE: true, NO_PLAUSIBLE_CANDIDATE: true, CLEAR_WINNER: true, AMBIGUOUS: true, BELOW_AUTO_THRESHOLD: true,
  LOW_EXTRACTION_CONFIDENCE: true, POSSIBLE_DUPLICATE: true,
};

describe('review page labels', () => {
  it.each(Object.keys(FLAGS))('flag %s has a short label and a plain-language explanation', (flag) => {
    expect(flagLabel(flag)).not.toBe(flag);
    expect(flagText(flag)).not.toBe(flag);
    expect(flagText(flag).length).toBeGreaterThan(flagLabel(flag).length);
  });

  // CLEAR_WINNER is never shown (those documents are MATCHED, not in the review queue)
  it.each(Object.keys(MATCHER_REASONS).filter((r) => r !== 'CLEAR_WINNER'))('reason %s is explained', (reason) => {
    expect(reasonText(reason)).not.toBe(reason);
  });

  it('the pipeline reasons stored after a decision are explained too', () => {
    for (const r of ['CONFIRM_RACE_LOST', 'ALL_CANDIDATES_REJECTED', 'CANDIDATE_TAKEN']) expect(reasonText(r)).not.toBe(r);
  });

  it('the possible-duplicate wording the reviewer sees', () => {
    expect(flagText('ALREADY_CONFIRMED')).toBe('Possible duplicate: this transaction already has a confirmed document');
    expect(reasonText('POSSIBLE_DUPLICATE')).toMatch(/^Possible duplicate receipt/);
  });

  it('unknown codes fall back to the raw code instead of crashing', () => {
    expect(flagText('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(flagLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(reasonText(null)).toBe('No reason recorded');
  });
});
