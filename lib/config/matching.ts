/**
 * All tunable matcher numbers live here so they can be reviewed (and tuned
 * against real review decisions) in one place. See IMPLEMENTATION.md for the
 * reasoning behind each default.
 */
export interface MatcherConfig {
  /** Signal weights. Sum of all four = 1.0. card is a bonus: null card signal contributes 0. */
  weights: { amount: number; merchant: number; date: number; card: number };

  /** top score >= this (and margin and confidence rules hold) => AUTO_MATCHED */
  autoThreshold: number;
  /** score below this is not a plausible candidate */
  reviewFloor: number;
  /** top - runnerUp must be >= this for AUTO_MATCHED */
  minMargin: number;
  /** extraction.confidence below this can never auto-match */
  minConfidenceForAuto: number;

  /** |txn - doc| <= this (minor units) counts as rounding */
  roundingTolMinor: number;
  /** a card charge may exceed the invoice by up to this fraction (tip) */
  tipMaxRatio: number;
  /** VAT in basis points (1500 = 15%). Used for the "document shows pre-VAT total" case. */
  vatBps: number;
  /** multiplier on the amount signal when only the pre-VAT interpretation fits */
  preVatSignalFactor: number;

  /** if amount signal < amountGate, total is capped at gateCap */
  amountGate: number;
  gateCap: number;
  /** total is multiplied by this when both last4 values are known and differ */
  cardMismatchMultiplier: number;

  /** invoice dated before the charge: max days still plausible, signal = 1 - lagDecayPerDay * days */
  maxLagDays: number;
  lagDecayPerDay: number;
  /** invoice dated up to this many days AFTER the charge is still plausible */
  maxLeadDays: number;
  /** signal for an invoice dated within maxLeadDays after the charge */
  leadSignal: number;
  /** signal used when the document has no readable date */
  dateMissingSignal: number;

  /** Calendar days are evaluated in this fixed offset. KSA = UTC+3, no DST. */
  utcOffsetMinutes: number;
}

export const DEFAULT_MATCHER_CONFIG: MatcherConfig = {
  weights: { amount: 0.45, merchant: 0.25, date: 0.2, card: 0.1 },
  autoThreshold: 0.85,
  reviewFloor: 0.5,
  minMargin: 0.1,
  minConfidenceForAuto: 0.6,
  roundingTolMinor: 5,
  tipMaxRatio: 0.2,
  vatBps: 1500,
  preVatSignalFactor: 0.9,
  amountGate: 0.05,
  gateCap: 0.49,
  cardMismatchMultiplier: 0.5,
  maxLagDays: 3,
  lagDecayPerDay: 0.2,
  maxLeadDays: 1,
  leadSignal: 0.7,
  dateMissingSignal: 0.5,
  utcOffsetMinutes: 180,
};
