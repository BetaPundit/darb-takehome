import { z } from 'zod';

export const documentTypeSchema = z.enum(['RECEIPT', 'TAX_INVOICE', 'UNKNOWN']);
export type DocumentType = z.infer<typeof documentTypeSchema>;

/**
 * Structured output of OCR. Every field except `documentType`, `rawText` and
 * `confidence` is nullable because real OCR routinely fails to read fields.
 * The matcher must treat null as "unknown", never as zero or empty.
 */
export const extractedDocumentSchema = z.object({
  documentType: documentTypeSchema,
  merchantName: z.string().nullable(),
  /** KSA VAT registration number: 15 digits, starts and ends with 3. */
  vatNumber: z.string().nullable(),
  /** VAT-inclusive total as printed, in integer minor units (halalas). */
  amountMinor: z.number().int().nonnegative().nullable(),
  /** ISO 4217, e.g. "SAR". */
  currency: z.string().length(3).nullable(),
  /** Calendar date as printed, 'YYYY-MM-DD'. A date, not an instant: receipts carry no timezone. */
  documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  cardLast4: z.string().regex(/^\d{4}$/).nullable(),
  invoiceNumber: z.string().nullable(),
  rawText: z.string(),
  /** Extractor's self-reported confidence, 0..1. */
  confidence: z.number().min(0).max(1),
});
export type ExtractedDocument = z.infer<typeof extractedDocumentSchema>;

export interface ExtractInput {
  bytes: Buffer;
  mimeType: string;
  fileName?: string;
}

/** Deliberately knows nothing about the sender or transactions, so it cannot be biased toward an answer. */
export interface DocumentExtractor {
  extract(input: ExtractInput): Promise<ExtractedDocument>;
}

export type ExtractionErrorCode = 'UNKNOWN_FIXTURE' | 'FIXTURE_FORCED_FAILURE' | 'TIMEOUT' | 'PROVIDER_ERROR' | 'INVALID_OUTPUT';

export class ExtractionError extends Error {
  constructor(
    readonly code: ExtractionErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ExtractionError';
  }
}
