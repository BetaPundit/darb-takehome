import type { MatcherConfig } from '@/lib/config/matching';
import { addVat } from '@/lib/money';
import { documentDay } from './dates';
import { merchantSimilarity } from './similarity';

export type MatchFlag =
  | 'TIP_SUSPECTED'
  | 'PRE_VAT_AMOUNT'
  | 'CARD_MISMATCH'
  | 'DATE_MISSING'
  | 'DATE_OFFSET'
  | 'AMOUNT_BELOW_CHARGE'
  /** Set by the matcher, not by a signal: the candidate transaction already has a confirmed document. */
  | 'ALREADY_CONFIRMED';

/** Round to 4 decimals. Applied to every signal and score BEFORE thresholds are compared (0.35+0.3+0.2 !== 0.85 in floats). */
export function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

const MS_PER_DAY = 86_400_000;

interface AmountResult {
  value: number;
  flags: MatchFlag[];
}

/** The PLAN amount table for one interpretation of the document total. d = txn - doc, minor units. */
function amountTable(txnMinor: number, docMinor: number, cfg: MatcherConfig): AmountResult {
  const d = txnMinor - docMinor;
  const tipMax = round4(docMinor * cfg.tipMaxRatio);

  if (d === 0) return { value: 1, flags: [] };
  if (Math.abs(d) <= cfg.roundingTolMinor) return { value: 0.97, flags: [] };
  if (d > 0 && d <= tipMax) return { value: round4(0.85 - 0.45 * (d / tipMax)), flags: ['TIP_SUSPECTED'] };
  if (d < 0) return { value: 0, flags: ['AMOUNT_BELOW_CHARGE'] };
  return { value: 0, flags: [] };
}

/**
 * Best of: document total as printed, or document shows a pre-VAT total (charge = total + VAT).
 * The pre-VAT reading only counts when it fits exactly or within rounding. Letting it also use the
 * tip row would widen the accepted charge range to ~1.0x-1.38x the invoice and flood review with noise.
 */
export function amountSignal(txnMinor: number, docMinor: number, cfg: MatcherConfig): AmountResult {
  const direct = amountTable(txnMinor, docMinor, cfg);
  const pre = amountTable(txnMinor, addVat(docMinor, cfg.vatBps), cfg);
  const preValue = round4(pre.value * cfg.preVatSignalFactor);
  if (pre.flags.length === 0 && preValue > direct.value) return { value: preValue, flags: ['PRE_VAT_AMOUNT'] };
  return direct;
}

export interface DateResult {
  value: number;
  /** txnDay - docDay in calendar days; null when the document date is unusable. */
  dayDiff: number | null;
  flags: MatchFlag[];
}

export function dateSignal(occurredAt: Date, docDate: string | null, cfg: MatcherConfig): DateResult {
  const docDay = docDate === null ? null : documentDay(docDate, cfg.utcOffsetMinutes);
  if (docDay === null) return { value: cfg.dateMissingSignal, dayDiff: null, flags: ['DATE_MISSING'] };

  const txnDay = Math.floor((occurredAt.getTime() + cfg.utcOffsetMinutes * 60_000) / MS_PER_DAY);
  const dd = txnDay - docDay;

  let value = 0;
  if (dd === 0) value = 1;
  else if (dd >= 1 && dd <= cfg.maxLagDays) value = round4(1 - cfg.lagDecayPerDay * dd);
  else if (dd < 0 && dd >= -cfg.maxLeadDays) value = cfg.leadSignal;

  return { value, dayDiff: dd, flags: value > 0 && dd !== 0 ? ['DATE_OFFSET'] : [] };
}

export function cardSignal(docLast4: string | null, txnLast4: string | null): { value: number | null; flags: MatchFlag[] } {
  if (docLast4 === null || txnLast4 === null) return { value: null, flags: [] };
  if (docLast4 === txnLast4) return { value: 1, flags: [] };
  return { value: 0, flags: ['CARD_MISMATCH'] };
}

export function merchantSignal(docMerchant: string | null, txnMerchant: string): number {
  if (docMerchant === null) return 0;
  return round4(merchantSimilarity(docMerchant, txnMerchant));
}
