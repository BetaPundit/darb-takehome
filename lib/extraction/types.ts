import { z } from 'zod';
import { isValidDocumentDate } from '@/lib/matching/dates';

export const documentTypeSchema = z.enum(['RECEIPT', 'TAX_INVOICE', 'UNKNOWN']);
export type DocumentType = z.infer<typeof documentTypeSchema>;

/**
 * Structured output of OCR (the assignment's `ExtractedDocument`). Every field except `documentType`, `rawText` and
 * `extractionConfidence` is nullable because real OCR routinely fails to read fields.
 * The matcher must treat null as "unknown", never as zero or empty.
 */
export const extractedDocumentSchema = z.object({
  documentType: documentTypeSchema,
  merchantName: z.string().nullable(),
  /** KSA VAT registration number: 15 digits, starts and ends with 3. */
  vatNumber: z.string().nullable(),
  /** VAT-inclusive total as printed, in integer minor units (halalas). */
  totalAmount: z.number().int().nonnegative().nullable(),
  /** ISO 4217, e.g. "SAR". */
  currency: z.string().length(3).nullable(),
  /**
   * ISO 8601: 'YYYY-MM-DD' (a calendar day, as printed on a receipt) or a datetime with 'Z' or an offset
   * ('2026-10-01T09:15:00+03:00'). Parsed by the same helper the matcher uses, so what validates can always be matched.
   */
  documentDate: z.string().refine(isValidDocumentDate, 'Expected an ISO 8601 date or datetime with Z or an offset').nullable(),
  cardLast4: z.string().regex(/^\d{4}$/).nullable(),
  invoiceNumber: z.string().nullable(),
  rawText: z.string(),
  /** Extractor's self-reported confidence, 0..1. */
  extractionConfidence: z.number().min(0).max(1),
});
export type ExtractedDocument = z.infer<typeof extractedDocumentSchema>;

/** Deliberately knows nothing about the sender or transactions, so it cannot be biased toward an answer. */
export interface DocumentExtractor {
  extract(file: Buffer, mimeType: string): Promise<ExtractedDocument>;
}

export const EXTRACTION_ERROR_CODES = ['UNKNOWN_FIXTURE', 'FIXTURE_FORCED_FAILURE', 'TIMEOUT', 'PROVIDER_ERROR', 'INVALID_OUTPUT'] as const;
export type ExtractionErrorCode = (typeof EXTRACTION_ERROR_CODES)[number];

export class ExtractionError extends Error {
  constructor(
    readonly code: ExtractionErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ExtractionError';
  }
}
