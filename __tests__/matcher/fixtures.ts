import { FIXTURE_NAMES, fixtureExpected, type FixtureName } from '@/lib/extraction/fixtures';
import type { ExtractedDocument } from '@/lib/extraction/types';
import type { MatcherCandidate, MatchSender } from '@/lib/services/transaction-matcher';

/** Riyadh wall-clock time as a UTC instant (UTC+3, no DST). */
export const at = (ymd: string, hm = '12:00'): Date => new Date(`${ymd}T${hm}:00+03:00`);

export function doc(overrides: Partial<ExtractedDocument> = {}): ExtractedDocument {
  return {
    documentType: 'RECEIPT',
    merchantName: 'Al Baik',
    vatNumber: null,
    totalAmount: 4500,
    currency: 'SAR',
    documentDate: '2026-10-02',
    cardLast4: null,
    invoiceNumber: null,
    rawText: '',
    extractionConfidence: 0.9,
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
  seeded('txn_alfanar', ALNOOR, D1, 'ALFANAR FUEL ST 04 RUH', 28750, '2026-10-06', '11:05', null),
  seeded('txn_restaurant', ALNOOR, D2, 'AL ROMANSIAH RESTAURANT', 6325, '2026-10-07', '14:20', null),
  seeded('txn_noise_1', DESERT, D3, 'EXTRA STORES 33', 15900, '2026-10-05', '09:00', null),
  seeded('txn_noise_2', ALNOOR, D2, 'UBER TRIP', 4100, '2026-10-06', '19:30', null),
  seeded('txn_noise_3', ALNOOR, D1, 'PANDA HYPER 07', 31250, '2026-10-02', '16:10', null),
];

/** The OCR output of every fixture in fixtures/extractions, so the matcher scenarios cannot drift from the files. */
type ScenarioName = Exclude<FixtureName, 'forced_failure'>;
export const SCENARIO_DOCS = Object.fromEntries(
  FIXTURE_NAMES.filter((n): n is ScenarioName => n !== 'forced_failure').map((n) => [n, fixtureExpected(n)]),
) as Record<ScenarioName, ExtractedDocument>;

export const SENDERS = { alnoor_d1: wa(D1), alnoor_d2: wa(D2), desert_d3: wa(D3), alnoor_email: email(ALNOOR), desert_email: email(DESERT) };
