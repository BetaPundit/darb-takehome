import { DEFAULT_MATCHER_CONFIG as CONFIG } from '@/lib/config/matching';
import { documentDay } from '@/lib/matching/dates';
import { formatMinor } from '@/lib/money';

/**
 * What a reviewer needs to decide is HOW a candidate agrees or differs, not an abstract percentage. These helpers turn
 * the raw facts (receipt vs transaction) into a short value and a plain-language note, plus a tone for colour and icon.
 * They read the facts directly (never the stored signal numbers), so what is shown is what is true of the data.
 */
export type Tone = 'good' | 'partial' | 'bad' | 'unknown';
export interface Evidence {
  tone: Tone;
  value: string;
  note: string;
}

const MS_PER_DAY = 86_400_000;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function amountEvidence(docAmount: number | null, txn: { amountMinor: number; currency: string }, flags: readonly string[]): Evidence {
  const value = formatMinor(txn.amountMinor, txn.currency);
  if (docAmount === null || docAmount <= 0) return { tone: 'unknown', value, note: 'No amount on the receipt' };

  // The matcher decided the receipt shows the amount before VAT: say that, whatever the numbers look like.
  if (flags.includes('PRE_VAT_AMOUNT')) return { tone: 'partial', value, note: `Receipt amount plus ${CONFIG.vatBps / 100}% VAT` };

  const diff = txn.amountMinor - docAmount;
  if (diff === 0) return { tone: 'good', value, note: 'Same as the receipt' };
  if (Math.abs(diff) <= CONFIG.roundingTolMinor) return { tone: 'good', value, note: `Off by ${formatMinor(Math.abs(diff), txn.currency)} (rounding)` };

  const size = formatMinor(Math.abs(diff), txn.currency);
  if (diff > 0) {
    const percent = Math.round((diff / docAmount) * 100);
    const tip = flags.includes('TIP_SUSPECTED') ? ', maybe a tip' : '';
    return { tone: 'partial', value, note: `${size} (${percent}%) more than the receipt${tip}` };
  }
  return { tone: 'bad', value, note: `${size} less than the receipt` };
}

const riyadhTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Riyadh', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Calendar days are compared in Riyadh, the same rule the matcher uses. */
export function dateEvidence(docDate: string | null, occurredAt: Date): Evidence {
  const value = riyadhTime.format(occurredAt);
  const docDay = docDate === null ? null : documentDay(docDate, CONFIG.utcOffsetMinutes);
  if (docDay === null) return { tone: 'unknown', value, note: 'No date on the receipt' };

  const chargeDay = Math.floor((occurredAt.getTime() + CONFIG.utcOffsetMinutes * 60_000) / MS_PER_DAY);
  const days = chargeDay - docDay;
  if (days === 0) return { tone: 'good', value, note: 'Same day' };
  if (days > 0 && days <= CONFIG.maxLagDays) return { tone: 'partial', value, note: `Charged ${plural(days, 'day')} after the receipt date` };
  if (days < 0 && -days <= CONFIG.maxLeadDays) return { tone: 'partial', value, note: `Receipt is dated ${plural(-days, 'day')} after the charge` };
  return { tone: 'bad', value, note: `${plural(Math.abs(days), 'day')} apart` };
}

export function merchantEvidence(similarity: number | null): Evidence {
  if (similarity === null) return { tone: 'unknown', value: 'Not scored', note: 'No stored comparison' };
  const note = `${Math.round(similarity * 100)}% match`;
  if (similarity >= 0.9) return { tone: 'good', value: 'Same name', note };
  if (similarity >= 0.6) return { tone: 'partial', value: 'Similar name', note };
  return { tone: 'bad', value: 'Different name', note };
}

export function cardEvidence(docLast4: string | null, txnLast4: string | null): Evidence {
  if (docLast4 === null) return { tone: 'unknown', value: '—', note: 'No card number on the receipt' };
  if (txnLast4 === null) return { tone: 'unknown', value: '—', note: 'Transaction has no card number' };
  if (docLast4 === txnLast4) return { tone: 'good', value: `•••• ${txnLast4}`, note: 'Same card' };
  return { tone: 'bad', value: `•••• ${txnLast4}`, note: `Receipt shows •••• ${docLast4}` };
}

/** Below the matcher's auto-match bar the extracted fields may be wrong, which the page should say out loud. */
export function ocrConfidence(confidence: number): { percent: number; low: boolean } {
  return { percent: Math.round(confidence * 100), low: confidence < CONFIG.minConfidenceForAuto };
}

const calendarDay = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });

/** The receipt's own date as a calendar day (a datetime is shown as its Riyadh day, like everywhere else). */
export function formatDocumentDate(docDate: string | null): string {
  const day = docDate === null ? null : documentDay(docDate, CONFIG.utcOffsetMinutes);
  return day === null ? 'No date' : calendarDay.format(new Date(day * MS_PER_DAY));
}
