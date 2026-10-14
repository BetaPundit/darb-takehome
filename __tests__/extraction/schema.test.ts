import { extractedDocumentSchema, type DocumentExtractor, type ExtractedDocument } from '@/lib/extraction/types';

const valid: ExtractedDocument = {
  documentType: 'RECEIPT',
  merchantName: 'Aramco Retail Station 0412',
  vatNumber: null,
  totalAmount: 18750,
  currency: 'SAR',
  documentDate: '2026-10-01',
  cardLast4: null,
  invoiceNumber: null,
  rawText: 'Total: 187.50 SAR',
  extractionConfidence: 0.95,
};

const parse = (over: Record<string, unknown>) => extractedDocumentSchema.safeParse({ ...valid, ...over });

describe('extractedDocumentSchema: the assignment ExtractedDocument', () => {
  it('has exactly the assignment field names', () => {
    expect(Object.keys(extractedDocumentSchema.shape).sort()).toEqual(
      ['cardLast4', 'currency', 'documentDate', 'documentType', 'extractionConfidence', 'invoiceNumber', 'merchantName', 'rawText', 'totalAmount', 'vatNumber'],
    );
  });

  it('DocumentExtractor.extract takes the file and its mime type positionally', () => {
    const extractor: DocumentExtractor = { extract: async (file: Buffer, mimeType: string) => (file.length > 0 && mimeType ? valid : valid) };
    return expect(extractor.extract(Buffer.from('x'), 'image/png')).resolves.toEqual(valid);
  });

  it('a row stored before the rename (amountMinor / confidence) no longer parses, which is what the review page falls back on', () => {
    const { totalAmount, extractionConfidence, ...rest } = valid;
    const oldShape = { ...rest, amountMinor: totalAmount, confidence: extractionConfidence };
    expect(extractedDocumentSchema.safeParse(oldShape).success).toBe(false);
  });

  describe('documentDate is ISO 8601', () => {
    it.each([
      ['a date', '2026-10-01'],
      ['a UTC datetime (the assignment example)', '2025-06-14T09:21:00Z'],
      ['an offset datetime', '2026-10-01T09:15:00+03:00'],
      ['a negative offset', '2026-10-01T09:15:00-05:00'],
      ['a datetime with fractional seconds', '2026-10-01T09:15:00.250Z'],
      ['a leap day', '2024-02-29'],
      ['no date', null],
    ])('accepts %s', (_name, documentDate) => {
      expect(parse({ documentDate }).success).toBe(true);
    });

    it.each([
      ['garbage', 'yesterday'],
      ['an empty string', ''],
      ['an impossible date', '2026-02-30'],
      ['a non-leap February 29', '2026-02-29'],
      ['month 13', '2026-13-01'],
      ['a datetime with no Z or offset', '2026-10-01T09:15:00'],
      ['hour 24', '2026-10-01T24:00:00Z'],
      ['a slash date', '01/10/2026'],
      ['a number', 20261001],
    ])('rejects %s', (_name, documentDate) => {
      expect(parse({ documentDate }).success).toBe(false);
    });

    it('the value is passed through untouched (no normalisation)', () => {
      const r = parse({ documentDate: '2026-10-01T09:15:00+03:00' });
      expect(r.success && r.data.documentDate).toBe('2026-10-01T09:15:00+03:00');
    });
  });
});
