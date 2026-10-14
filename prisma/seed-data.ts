import type { PrismaClient } from '@/lib/generated/prisma/client';
import type { ExtractedDocument } from '@/lib/extraction/types';

// Contract: .claude scratchpad SCENARIOS.md. All amounts are SAR halalas. All instants are fixed
// absolute dates (Riyadh is UTC+3, no DST) so tests are deterministic. Do not make these relative.

export const clients = [
  { id: 'client_alnoor', name: 'Al Noor Logistics' },
  { id: 'client_desert', name: 'Desert Fleet Co' },
];

export const senders = [
  { id: 'sender_alnoor', clientId: 'client_alnoor', email: 'ap@alnoor.example' },
  { id: 'sender_desert', clientId: 'client_desert', email: 'accounts@desertfleet.example' },
  // Demo mapping so the assignment's sample email payload (from billing@alfanar-fuel.com.sa) is accepted:
  // that supplier address is treated as a mailbox of Al Noor. A real deployment registers a client's own
  // mailboxes, not a supplier's.
  { id: 'sender_alfanar', clientId: 'client_alnoor', email: 'billing@alfanar-fuel.com.sa' },
];

const ALNOOR_DRIVER_1 = '+966501111111';
const ALNOOR_DRIVER_2 = '+966502222222';
const DESERT_DRIVER = '+966503333333';

type SeedTransaction = {
  id: string;
  clientId: string;
  driverPhone: string;
  merchantName: string;
  amountMinor: number;
  occurredAt: Date;
  cardLast4: string | null;
};

const transactionRows: SeedTransaction[] = [
  { id: 'txn_exact', clientId: 'client_alnoor', driverPhone: ALNOOR_DRIVER_1, merchantName: 'ARAMCO RETAIL 0412', amountMinor: 18750, occurredAt: new Date('2026-10-01T09:15:00+03:00'), cardLast4: null },
  { id: 'txn_amb_1', clientId: 'client_alnoor', driverPhone: ALNOOR_DRIVER_1, merchantName: 'AL BAIK', amountMinor: 4500, occurredAt: new Date('2026-10-02T12:30:00+03:00'), cardLast4: '4242' },
  { id: 'txn_amb_2', clientId: 'client_alnoor', driverPhone: ALNOOR_DRIVER_1, merchantName: 'AL BAIK', amountMinor: 4500, occurredAt: new Date('2026-10-02T19:45:00+03:00'), cardLast4: '9911' },
  { id: 'txn_tip', clientId: 'client_alnoor', driverPhone: ALNOOR_DRIVER_2, merchantName: 'STARBUCKS #12345 RIYADH', amountMinor: 6600, occurredAt: new Date('2026-10-03T08:05:00+03:00'), cardLast4: null },
  { id: 'txn_round', clientId: 'client_alnoor', driverPhone: ALNOOR_DRIVER_2, merchantName: 'PANDA RETAIL CO.', amountMinor: 23103, occurredAt: new Date('2026-10-03T17:40:00+03:00'), cardLast4: null },
  { id: 'txn_prevat', clientId: 'client_alnoor', driverPhone: ALNOOR_DRIVER_1, merchantName: 'JARIR BOOKSTORE RIYADH BRANCH', amountMinor: 11500, occurredAt: new Date('2026-10-04T13:00:00+03:00'), cardLast4: null },
  { id: 'txn_lowconf', clientId: 'client_alnoor', driverPhone: ALNOOR_DRIVER_2, merchantName: 'NADEC FOODS', amountMinor: 7200, occurredAt: new Date('2026-10-04T10:10:00+03:00'), cardLast4: null },
  // Already has a CONFIRMED match to doc_seed_confirmed.
  { id: 'txn_confirmed', clientId: 'client_alnoor', driverPhone: ALNOOR_DRIVER_1, merchantName: 'SASCO STATION 118', amountMinor: 8000, occurredAt: new Date('2026-10-01T07:30:00+03:00'), cardLast4: null },
  { id: 'txn_email', clientId: 'client_desert', driverPhone: DESERT_DRIVER, merchantName: 'ADNOC DISTRIBUTION', amountMinor: 25000, occurredAt: new Date('2026-10-04T15:20:00+03:00'), cardLast4: null },
  { id: 'txn_arabic', clientId: 'client_desert', driverPhone: DESERT_DRIVER, merchantName: 'مطعم البيك', amountMinor: 3500, occurredAt: new Date('2026-10-05T20:10:00+03:00'), cardLast4: null },
  // The assignment's own examples: acquirer name "ALFANAR FUEL ST 04 RUH" vs the invoice's "Alfanar Fuel Station",
  // and a restaurant receipt of 57.50 against a card charge of 63.25 (tip).
  { id: 'txn_alfanar', clientId: 'client_alnoor', driverPhone: ALNOOR_DRIVER_1, merchantName: 'ALFANAR FUEL ST 04 RUH', amountMinor: 28750, occurredAt: new Date('2026-10-06T11:05:00+03:00'), cardLast4: null },
  { id: 'txn_restaurant', clientId: 'client_alnoor', driverPhone: ALNOOR_DRIVER_2, merchantName: 'AL ROMANSIAH RESTAURANT', amountMinor: 6325, occurredAt: new Date('2026-10-07T14:20:00+03:00'), cardLast4: null },
  // Background noise: transactions no fixture is meant to match, so the matcher is not only ever shown the right answer.
  { id: 'txn_noise_1', clientId: 'client_desert', driverPhone: DESERT_DRIVER, merchantName: 'EXTRA STORES 33', amountMinor: 15900, occurredAt: new Date('2026-10-05T09:00:00+03:00'), cardLast4: null },
  { id: 'txn_noise_2', clientId: 'client_alnoor', driverPhone: ALNOOR_DRIVER_2, merchantName: 'UBER TRIP', amountMinor: 4100, occurredAt: new Date('2026-10-06T19:30:00+03:00'), cardLast4: null },
  { id: 'txn_noise_3', clientId: 'client_alnoor', driverPhone: ALNOOR_DRIVER_1, merchantName: 'PANDA HYPER 07', amountMinor: 31250, occurredAt: new Date('2026-10-02T16:10:00+03:00'), cardLast4: null },
];

export const transactions = transactionRows.map((t) => ({ ...t, currency: 'SAR', externalRef: `ext_${t.id}` }));

export const seedConfirmedExtraction: ExtractedDocument = {
  documentType: 'RECEIPT',
  merchantName: 'SASCO Station 118',
  vatNumber: null,
  totalAmount: 8000,
  currency: 'SAR',
  documentDate: '2026-10-01',
  cardLast4: null,
  invoiceNumber: null,
  rawText: 'SASCO Station 118\nTotal SAR 80.00\n2026-10-01',
  extractionConfidence: 0.95,
};

const SEED_CONTENT_HASH = 'a'.repeat(64);

export const seedDocument = {
  id: 'doc_seed_confirmed',
  source: 'EMAIL' as const,
  externalMessageId: 'seed-msg-confirmed',
  attachmentIndex: 0,
  scopeKey: 'client:client_alnoor',
  contentHash: SEED_CONTENT_HASH,
  senderRef: 'ap@alnoor.example',
  clientId: 'client_alnoor',
  blobKey: SEED_CONTENT_HASH,
  mimeType: 'application/pdf',
  status: 'MATCHED' as const,
  extraction: seedConfirmedExtraction,
  extractionConfidence: seedConfirmedExtraction.extractionConfidence,
  receivedAt: new Date('2026-10-01T10:00:00+03:00'),
};

export const seedMatch = {
  id: 'match_seed_confirmed',
  documentId: 'doc_seed_confirmed',
  transactionId: 'txn_confirmed',
  score: 1,
  rank: 1,
  signals: { amount: 1, merchant: 1, date: 1, card: null },
  status: 'CONFIRMED' as const,
  decidedBy: 'seed',
  decidedAt: new Date('2026-10-01T10:05:00+03:00'),
};

/** Wipes the app tables (children first) and reinserts the scenario data atomically. Idempotent. */
export async function seedDatabase(prisma: PrismaClient): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed: NODE_ENV is production (seeding deletes all data).');
  }
  await prisma.$transaction(async (tx) => {
    await tx.documentMatch.deleteMany();
    await tx.document.deleteMany();
    await tx.transaction.deleteMany();
    await tx.clientSender.deleteMany();
    await tx.client.deleteMany();

    await tx.client.createMany({ data: clients });
    await tx.clientSender.createMany({ data: senders });
    await tx.transaction.createMany({ data: transactions });
    await tx.document.create({ data: seedDocument });
    await tx.documentMatch.create({ data: seedMatch });
  });
}
