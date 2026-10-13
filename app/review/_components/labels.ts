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
};

const FLAGS: Record<string, string> = {
  TIP_SUSPECTED: 'Charge is higher than the invoice (tip?)',
  PRE_VAT_AMOUNT: 'Invoice amount looks pre-VAT',
  CARD_MISMATCH: 'Card last 4 differ',
  DATE_MISSING: 'Document has no readable date',
  DATE_OFFSET: 'Document date differs from the charge date',
  AMOUNT_BELOW_CHARGE: 'Invoice amount is below the charge',
};

export const reasonText = (code: string | null) => (code ? (REASONS[code] ?? code) : 'No reason recorded');
export const flagText = (code: string) => FLAGS[code] ?? code;

const riyadh = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Riyadh', dateStyle: 'medium', timeStyle: 'short' });
export const formatRiyadh = (d: Date) => `${riyadh.format(d)} (Riyadh)`;
