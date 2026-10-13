import { DEFAULT_MATCHER_CONFIG, type MatcherConfig } from '@/lib/config/matching';
import type { ExtractedDocument } from '@/lib/extraction/types';
import { amountSignal, cardSignal, dateSignal, merchantSignal, round4, type MatchFlag } from '@/lib/matching/signals';

/**
 * Pure matching engine: no I/O, no clock, no randomness, inputs are never mutated.
 * All numbers come from MatcherConfig. Scores and signals are rounded to 4 decimals
 * before any threshold or margin comparison, so boundaries behave exactly.
 */

export type { MatchFlag };

export const MAX_RESULT_CANDIDATES = 5;

export type MatchSender =
  | { kind: 'WHATSAPP'; phone: string } // E.164, compared strictly
  | { kind: 'EMAIL'; clientId: string };

export interface MatcherCandidate {
  id: string;
  clientId: string;
  driverPhone: string | null;
  merchantName: string;
  amountMinor: number;
  currency: string;
  occurredAt: Date;
  cardLast4: string | null;
  /** true if a confirmed match already exists for this transaction */
  alreadyConfirmed: boolean;
}

export interface MatchInput {
  document: ExtractedDocument;
  sender: MatchSender;
  candidates: readonly MatcherCandidate[];
  config?: MatcherConfig;
}

export interface SignalBreakdown {
  amount: number;
  merchant: number;
  date: number;
  card: number | null;
}

export interface ScoredCandidate {
  transactionId: string;
  score: number;
  signals: SignalBreakdown;
  flags: MatchFlag[];
}

export type MatchOutcome = 'AUTO_MATCHED' | 'NEEDS_REVIEW' | 'UNMATCHED';
export type MatchReason =
  | 'INSUFFICIENT_DATA'
  | 'NO_CANDIDATES_IN_SCOPE'
  | 'NO_PLAUSIBLE_CANDIDATE'
  | 'CLEAR_WINNER'
  | 'AMBIGUOUS'
  | 'BELOW_AUTO_THRESHOLD'
  | 'LOW_EXTRACTION_CONFIDENCE';

export interface MatchResult {
  outcome: MatchOutcome;
  reason: MatchReason;
  /** Plausible candidates only (score >= reviewFloor), best first, at most MAX_RESULT_CANDIDATES. Empty when UNMATCHED. */
  candidates: ScoredCandidate[];
}

interface Ranked {
  scored: ScoredCandidate;
  /** |calendar-day difference|, used only as a ranking tiebreak. Infinity when unknown. */
  absDayDiff: number;
}

const unmatched = (reason: MatchReason): MatchResult => ({ outcome: 'UNMATCHED', reason, candidates: [] });

function inScope(c: MatcherCandidate, sender: MatchSender): boolean {
  return sender.kind === 'WHATSAPP' ? c.driverPhone === sender.phone : c.clientId === sender.clientId;
}

function score(c: MatcherCandidate, doc: ExtractedDocument & { amountMinor: number }, config: MatcherConfig): Ranked {
  const amount = amountSignal(c.amountMinor, doc.amountMinor, config);
  const merchant = merchantSignal(doc.merchantName, c.merchantName);
  const date = dateSignal(c.occurredAt, doc.documentDate, config);
  const card = cardSignal(doc.cardLast4, c.cardLast4);
  const w = config.weights;

  // A null card signal contributes 0 and is not renormalized: a document without last4 tops out at 0.90.
  let total = round4(w.amount * amount.value + w.merchant * merchant + w.date * date.value + w.card * (card.value ?? 0));
  // Without an amount signal there is no plausible match, whatever the merchant and date say.
  if (amount.value < config.amountGate) total = Math.min(total, config.gateCap);
  if (card.flags.includes('CARD_MISMATCH')) total = round4(total * config.cardMismatchMultiplier);

  return {
    scored: {
      transactionId: c.id,
      score: total,
      signals: { amount: amount.value, merchant, date: date.value, card: card.value },
      flags: [...amount.flags, ...date.flags, ...card.flags],
    },
    absDayDiff: date.dayDiff === null || !Number.isFinite(date.dayDiff) ? Infinity : Math.abs(date.dayDiff),
  };
}

/** score desc, then closer calendar day, then id asc: a total order, so input order never matters. */
function compareRanked(a: Ranked, b: Ranked): number {
  if (a.scored.score !== b.scored.score) return b.scored.score - a.scored.score;
  if (a.absDayDiff !== b.absDayDiff) return a.absDayDiff < b.absDayDiff ? -1 : 1;
  if (a.scored.transactionId === b.scored.transactionId) return 0;
  return a.scored.transactionId < b.scored.transactionId ? -1 : 1;
}

export function matchDocument(input: MatchInput): MatchResult {
  const { document, sender, candidates, config = DEFAULT_MATCHER_CONFIG } = input;

  // 1. Usable? A zero total is treated as unreadable: it would "exactly match" any zero-amount transaction.
  if (document.documentType === 'UNKNOWN' || document.amountMinor === null || document.amountMinor <= 0 || document.currency === null) {
    return unmatched('INSUFFICIENT_DATA');
  }
  const doc = { ...document, amountMinor: document.amountMinor };
  const currency = document.currency.toUpperCase();

  // 2. Hard filters.
  const eligible = candidates.filter((c) => !c.alreadyConfirmed && c.currency.toUpperCase() === currency && inScope(c, sender));
  if (eligible.length === 0) return unmatched('NO_CANDIDATES_IN_SCOPE');

  // 3-5. Score, rank, keep plausible.
  const plausible = eligible
    .map((c) => score(c, doc, config))
    .sort(compareRanked)
    .filter((r) => r.scored.score >= config.reviewFloor);
  if (plausible.length === 0) return unmatched('NO_PLAUSIBLE_CANDIDATE');

  const top = plausible[0]!.scored;
  const runnerUp = plausible[1]?.scored;
  const ranked = plausible.slice(0, MAX_RESULT_CANDIDATES).map((r) => r.scored);

  // 6. Decide.
  const lowConfidence = document.confidence < config.minConfidenceForAuto;
  const ambiguous = runnerUp !== undefined && round4(top.score - runnerUp.score) < config.minMargin;
  // A missing date removes a whole corroborating signal, so a card match must not be able to make up for it.
  const dateMissing = top.flags.includes('DATE_MISSING');

  if (top.score >= config.autoThreshold && !ambiguous && !lowConfidence && !dateMissing) {
    return { outcome: 'AUTO_MATCHED', reason: 'CLEAR_WINNER', candidates: ranked };
  }
  const reason: MatchReason = lowConfidence ? 'LOW_EXTRACTION_CONFIDENCE' : ambiguous ? 'AMBIGUOUS' : 'BELOW_AUTO_THRESHOLD';
  return { outcome: 'NEEDS_REVIEW', reason, candidates: ranked };
}
