import { sha256Hex } from './hash';
import type { ExtractedDocument, ExtractionErrorCode } from './types';

/**
 * Deterministic "OCR" fixtures. The values here are the shared contract with seed data,
 * matcher tests and the webhook demo script: do not change them without updating those.
 * A fixture's input bytes are the UTF-8 string `DARB-FIXTURE:<name>`.
 */
export type Fixture =
  | { name: string; content: string; expected: ExtractedDocument }
  | { name: string; content: string; throws: ExtractionErrorCode };

export const FIXTURES = {
  exact: {
    name: 'exact',
    content: 'DARB-FIXTURE:exact',
    expected: {
      documentType: 'RECEIPT',
      merchantName: 'Aramco Retail Station 0412',
      vatNumber: null,
      amountMinor: 18750,
      currency: 'SAR',
      documentDate: '2026-10-01',
      cardLast4: null,
      invoiceNumber: null,
      rawText: 'Aramco Retail Station 0412\nFuel - Diesel\nTotal: 187.50 SAR\nDate: 2026-10-01 09:15',
      confidence: 0.95,
    },
  },
  ambiguous: {
    name: 'ambiguous',
    content: 'DARB-FIXTURE:ambiguous',
    expected: {
      documentType: 'RECEIPT',
      merchantName: 'Al Baik',
      vatNumber: null,
      amountMinor: 4500,
      currency: 'SAR',
      documentDate: '2026-10-02',
      cardLast4: null,
      invoiceNumber: null,
      rawText: 'Al Baik\nMeal combo x2\nTotal: 45.00 SAR\nDate: 2026-10-02',
      confidence: 0.93,
    },
  },
  ambiguous_last4: {
    name: 'ambiguous_last4',
    content: 'DARB-FIXTURE:ambiguous_last4',
    expected: {
      documentType: 'RECEIPT',
      merchantName: 'Al Baik',
      vatNumber: null,
      amountMinor: 4500,
      currency: 'SAR',
      documentDate: '2026-10-02',
      cardLast4: '4242',
      invoiceNumber: null,
      rawText: 'Al Baik\nMeal combo x2\nTotal: 45.00 SAR\nCard: **** **** **** 4242\nDate: 2026-10-02',
      confidence: 0.93,
    },
  },
  tip: {
    name: 'tip',
    content: 'DARB-FIXTURE:tip',
    expected: {
      documentType: 'RECEIPT',
      merchantName: 'Starbucks Coffee Company',
      vatNumber: null,
      amountMinor: 6000,
      currency: 'SAR',
      documentDate: '2026-10-03',
      cardLast4: null,
      invoiceNumber: null,
      rawText: 'Starbucks Coffee Company\nLatte x2, Croissant x2\nTotal: 60.00 SAR\nDate: 2026-10-03',
      confidence: 0.9,
    },
  },
  rounding: {
    name: 'rounding',
    content: 'DARB-FIXTURE:rounding',
    expected: {
      documentType: 'RECEIPT',
      merchantName: 'Panda Retail Co',
      vatNumber: null,
      amountMinor: 23100,
      currency: 'SAR',
      documentDate: '2026-10-03',
      cardLast4: null,
      invoiceNumber: null,
      rawText: 'Panda Retail Co\nGroceries\nTotal: 231.00 SAR\nDate: 2026-10-03',
      confidence: 0.92,
    },
  },
  prevat: {
    name: 'prevat',
    content: 'DARB-FIXTURE:prevat',
    expected: {
      documentType: 'TAX_INVOICE',
      merchantName: 'Jarir Bookstore',
      vatNumber: '300112233400003',
      amountMinor: 10000,
      currency: 'SAR',
      documentDate: '2026-10-04',
      cardLast4: null,
      invoiceNumber: 'INV-4471',
      rawText:
        'Tax Invoice\nJarir Bookstore\nVAT No: 300112233400003\nInvoice: INV-4471\nAmount before VAT: 100.00 SAR\nVAT 15%: 15.00 SAR\nTotal: [illegible]\nDate: 2026-10-04',
      confidence: 0.94,
    },
  },
  no_transaction: {
    name: 'no_transaction',
    content: 'DARB-FIXTURE:no_transaction',
    expected: {
      documentType: 'TAX_INVOICE',
      merchantName: 'Saudi Electricity Company',
      vatNumber: '300000000000003',
      amountMinor: 99999,
      currency: 'SAR',
      documentDate: '2026-10-02',
      cardLast4: null,
      invoiceNumber: 'SEC-5521',
      rawText:
        'Tax Invoice\nSaudi Electricity Company\nVAT No: 300000000000003\nInvoice: SEC-5521\nTotal due: 999.99 SAR\nDate: 2026-10-02',
      confidence: 0.96,
    },
  },
  garbage: {
    name: 'garbage',
    content: 'DARB-FIXTURE:garbage',
    expected: {
      documentType: 'UNKNOWN',
      merchantName: null,
      vatNumber: null,
      amountMinor: null,
      currency: null,
      documentDate: null,
      cardLast4: null,
      invoiceNumber: null,
      rawText: '~~ xk# 0o0 ,, ;; ..',
      confidence: 0.1,
    },
  },
  low_confidence: {
    name: 'low_confidence',
    content: 'DARB-FIXTURE:low_confidence',
    expected: {
      documentType: 'RECEIPT',
      merchantName: 'Nadec Foods',
      vatNumber: null,
      amountMinor: 7200,
      currency: 'SAR',
      documentDate: '2026-10-04',
      cardLast4: null,
      invoiceNumber: null,
      rawText: 'N4DEC F00ds\nDa1ry\nTota1: 72.00 SAR\n2026-10-04',
      confidence: 0.45,
    },
  },
  email_exact: {
    name: 'email_exact',
    content: 'DARB-FIXTURE:email_exact',
    expected: {
      documentType: 'TAX_INVOICE',
      merchantName: 'ADNOC Distribution LLC',
      vatNumber: '300000000000003',
      amountMinor: 25000,
      currency: 'SAR',
      documentDate: '2026-10-04',
      cardLast4: null,
      invoiceNumber: 'INV-88231',
      rawText:
        'Tax Invoice\nADNOC Distribution LLC\nVAT No: 300000000000003\nInvoice: INV-88231\nFuel\nTotal: 250.00 SAR\nDate: 2026-10-04',
      confidence: 0.97,
    },
  },
  arabic: {
    name: 'arabic',
    content: 'DARB-FIXTURE:arabic',
    expected: {
      documentType: 'RECEIPT',
      merchantName: 'مطعم البيك - فرع الرياض',
      vatNumber: null,
      amountMinor: 3500,
      currency: 'SAR',
      documentDate: '2026-10-05',
      cardLast4: null,
      invoiceNumber: null,
      rawText: 'مطعم البيك - فرع الرياض\nوجبة\nالإجمالي: 35.00 ر.س\nالتاريخ: 2026-10-05',
      confidence: 0.9,
    },
  },
  already_confirmed: {
    name: 'already_confirmed',
    content: 'DARB-FIXTURE:already_confirmed',
    expected: {
      documentType: 'RECEIPT',
      merchantName: 'SASCO Station 118',
      vatNumber: null,
      amountMinor: 8000,
      currency: 'SAR',
      documentDate: '2026-10-01',
      cardLast4: null,
      invoiceNumber: null,
      rawText: 'SASCO Station 118\nFuel - 91\nTotal: 80.00 SAR\nDate: 2026-10-01 07:30',
      confidence: 0.95,
    },
  },
  forced_failure: {
    name: 'forced_failure',
    content: 'DARB-FIXTURE:forced_failure',
    throws: 'FIXTURE_FORCED_FAILURE',
  },
} as const satisfies Record<string, Fixture>;

export type FixtureName = keyof typeof FIXTURES;

export const fixtureNames = Object.keys(FIXTURES) as FixtureName[];

export function fixtureBytes(name: FixtureName): Buffer {
  return Buffer.from(FIXTURES[name].content, 'utf8');
}

export function fixtureHash(name: FixtureName): string {
  return sha256Hex(fixtureBytes(name));
}
