import type { ExtractedDocument } from '@/lib/extraction/types';
import type { MatcherCandidate, MatchSender } from '@/lib/services/transaction-matcher';

/** Riyadh wall-clock time as a UTC instant (UTC+3, no DST). */
export const at = (ymd: string, hm = '12:00'): Date => new Date(`${ymd}T${hm}:00+03:00`);

export function doc(overrides: Partial<ExtractedDocument> = {}): ExtractedDocument {
  return {
    documentType: 'RECEIPT',
    merchantName: 'Al Baik',
    vatNumber: null,
    amountMinor: 4500,
    currency: 'SAR',
    documentDate: '2026-10-02',
    cardLast4: null,
    invoiceNumber: null,
    rawText: '',
    confidence: 0.9,
    ...overrides,
  };
}

export const PHONE = '+966500000001';

export function txn(overrides: Partial<MatcherCandidate> = {}): MatcherCandidate {
  return {
    id: 't1',
    clientId: 'c1',
    driverPhone: PHONE,
    merchantName: 'AL BAIK',
    amountMinor: 4500,
    currency: 'SAR',
    occurredAt: at('2026-10-02'),
    cardLast4: null,
    alreadyConfirmed: false,
    ...overrides,
  };
}

export const wa = (phone: string): MatchSender => ({ kind: 'WHATSAPP', phone });
export const email = (clientId: string): MatchSender => ({ kind: 'EMAIL', clientId });
export const WA_SENDER = wa(PHONE);

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** Deterministic Fisher-Yates (mulberry32), so shuffle tests are reproducible. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let a = seed;
  const rand = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ---- Mirror of scratchpad SCENARIOS.md (seed data) -------------------------------------------

const ALNOOR = 'client_alnoor';
const DESERT = 'client_desert';
export const D1 = '+966501111111';
export const D2 = '+966502222222';
export const D3 = '+966503333333';

function seeded(
  id: string,
  clientId: string,
  driverPhone: string,
  merchantName: string,
  amountMinor: number,
  ymd: string,
  hm: string,
  cardLast4: string | null,
  alreadyConfirmed = false,
): MatcherCandidate {
  return { id, clientId, driverPhone, merchantName, amountMinor, currency: 'SAR', occurredAt: at(ymd, hm), cardLast4, alreadyConfirmed };
}

export const SEEDED_TXNS: readonly MatcherCandidate[] = [
  seeded('txn_exact', ALNOOR, D1, 'ARAMCO RETAIL 0412', 18750, '2026-10-01', '09:15', null),
  seeded('txn_amb_1', ALNOOR, D1, 'AL BAIK', 4500, '2026-10-02', '12:30', '4242'),
  seeded('txn_amb_2', ALNOOR, D1, 'AL BAIK', 4500, '2026-10-02', '19:45', '9911'),
  seeded('txn_tip', ALNOOR, D2, 'STARBUCKS #12345 RIYADH', 6600, '2026-10-03', '08:05', null),
  seeded('txn_round', ALNOOR, D2, 'PANDA RETAIL CO.', 23103, '2026-10-03', '17:40', null),
  seeded('txn_prevat', ALNOOR, D1, 'JARIR BOOKSTORE RIYADH BRANCH', 11500, '2026-10-04', '13:00', null),
  seeded('txn_lowconf', ALNOOR, D2, 'NADEC FOODS', 7200, '2026-10-04', '10:10', null),
  seeded('txn_confirmed', ALNOOR, D1, 'SASCO STATION 118', 8000, '2026-10-01', '07:30', null, true),
  seeded('txn_email', DESERT, D3, 'ADNOC DISTRIBUTION', 25000, '2026-10-04', '15:20', null),
  seeded('txn_arabic', DESERT, D3, 'مطعم البيك', 3500, '2026-10-05', '20:10', null),
];

type Fixture = Partial<ExtractedDocument> & Pick<ExtractedDocument, 'merchantName' | 'amountMinor' | 'documentDate' | 'confidence'>;
const fx = (f: Fixture): ExtractedDocument => doc(f);

export const SCENARIO_DOCS = {
  exact: fx({ merchantName: 'Aramco Retail Station 0412', amountMinor: 18750, documentDate: '2026-10-01', confidence: 0.95 }),
  ambiguous: fx({ merchantName: 'Al Baik', amountMinor: 4500, documentDate: '2026-10-02', confidence: 0.93 }),
  ambiguous_last4: fx({ merchantName: 'Al Baik', amountMinor: 4500, documentDate: '2026-10-02', cardLast4: '4242', confidence: 0.93 }),
  tip: fx({ merchantName: 'Starbucks Coffee Company', amountMinor: 6000, documentDate: '2026-10-03', confidence: 0.9 }),
  rounding: fx({ merchantName: 'Panda Retail Co', amountMinor: 23100, documentDate: '2026-10-03', confidence: 0.92 }),
  prevat: fx({
    documentType: 'TAX_INVOICE',
    merchantName: 'Jarir Bookstore',
    amountMinor: 10000,
    documentDate: '2026-10-04',
    invoiceNumber: 'INV-4471',
    vatNumber: '300112233400003',
    confidence: 0.94,
  }),
  no_transaction: fx({
    documentType: 'TAX_INVOICE',
    merchantName: 'Saudi Electricity Company',
    amountMinor: 99999,
    documentDate: '2026-10-02',
    invoiceNumber: 'SEC-5521',
    vatNumber: '300000000000003',
    confidence: 0.96,
  }),
  garbage: fx({ documentType: 'UNKNOWN', merchantName: null, amountMinor: null, currency: null, documentDate: null, confidence: 0.1 }),
  low_confidence: fx({ merchantName: 'Nadec Foods', amountMinor: 7200, documentDate: '2026-10-04', confidence: 0.45 }),
  email_exact: fx({
    documentType: 'TAX_INVOICE',
    merchantName: 'ADNOC Distribution LLC',
    amountMinor: 25000,
    documentDate: '2026-10-04',
    invoiceNumber: 'INV-88231',
    vatNumber: '300000000000003',
    confidence: 0.97,
  }),
  arabic: fx({ merchantName: 'مطعم البيك - فرع الرياض', amountMinor: 3500, documentDate: '2026-10-05', confidence: 0.9 }),
  already_confirmed: fx({ merchantName: 'SASCO Station 118', amountMinor: 8000, documentDate: '2026-10-01', confidence: 0.95 }),
} satisfies Record<string, ExtractedDocument>;

export const SENDERS = { alnoor_d1: wa(D1), alnoor_d2: wa(D2), desert_d3: wa(D3), alnoor_email: email(ALNOOR), desert_email: email(DESERT) };
