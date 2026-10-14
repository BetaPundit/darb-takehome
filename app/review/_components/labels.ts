/** Plain-language text for codes the pipeline stores. Unknown codes fall back to the raw code, never crash. */

const REASONS: Record<string, string> = {
  AMBIGUOUS: 'Several transactions fit about equally well',
  BELOW_AUTO_THRESHOLD: 'Best candidate is not confident enough to match automatically',
  LOW_EXTRACTION_CONFIDENCE: 'The document was hard to read, so the extracted fields may be wrong',
  CONFIRM_RACE_LOST: 'The best transaction was taken by another document while matching',
  ALL_CANDIDATES_REJECTED: 'Every candidate was rejected by a reviewer',
  CANDIDATE_TAKEN: 'The candidate transactions were matched to other documents',
  NO_PLAUSIBLE_CANDIDATE: 'No transaction is close enough to this document',
  NO_CANDIDATES_IN_SCOPE: 'There are no transactions for this sender in the date range',
  INSUFFICIENT_DATA: 'Not enough could be read from the document to match it',
  POSSIBLE_DUPLICATE: 'Possible duplicate receipt: the best match already has a confirmed document',
};

const FLAGS: Record<string, string> = {
  TIP_SUSPECTED: 'Charge is higher than the invoice (tip?)',
  PRE_VAT_AMOUNT: 'Invoice amount looks pre-VAT',
  CARD_MISMATCH: 'Card last 4 differ',
  DATE_MISSING: 'Document has no readable date',
  DATE_OFFSET: 'Document date differs from the charge date',
  AMOUNT_BELOW_CHARGE: 'Invoice amount is below the charge',
  ALREADY_CONFIRMED: 'Possible duplicate: this transaction already has a confirmed document',
};

/** Short badge text; the sentence in FLAGS is the explanation (tooltip, and text for screen readers). */
const FLAG_LABELS: Record<string, string> = {
  TIP_SUSPECTED: 'Tip suspected',
  PRE_VAT_AMOUNT: 'Pre-VAT amount',
  CARD_MISMATCH: 'Card mismatch',
  DATE_MISSING: 'No date',
  DATE_OFFSET: 'Date differs',
  AMOUNT_BELOW_CHARGE: 'Below charge',
  ALREADY_CONFIRMED: 'Possible duplicate',
};

export const reasonText = (code: string | null) => (code ? (REASONS[code] ?? code) : 'No reason recorded');
export const flagText = (code: string) => FLAGS[code] ?? code;
export const flagLabel = (code: string) => FLAG_LABELS[code] ?? code;
/** The candidate's transaction already has a confirmed document. Stored by the matcher in the candidate's flags. */
export const ALREADY_CONFIRMED_FLAG = 'ALREADY_CONFIRMED';

const riyadh = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Riyadh', dateStyle: 'medium', timeStyle: 'short' });
export const formatRiyadh = (d: Date) => `${riyadh.format(d)} (Riyadh)`;
