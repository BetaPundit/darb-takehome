import { Prisma } from '@/lib/generated/prisma/client';
import type { PrismaClient } from '@/lib/generated/prisma/client';
import { seedDatabase } from '@/prisma/seed-data';
import { createTestDb } from '../helpers/test-db';

let db: PrismaClient;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
});
afterAll(() => cleanup());
beforeEach(() => seedDatabase(db));

/** Resolves with the Prisma error (code + meta) a write rejects with, failing if it succeeds. */
async function rejection(p: Promise<unknown>): Promise<Prisma.PrismaClientKnownRequestError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) return e;
    throw e;
  }
  throw new Error('expected the write to be rejected');
}

/** Columns of the violated unique constraint, so callers can tell which guarantee fired. */
function violatedFields(err: Prisma.PrismaClientKnownRequestError): string[] {
  return (err.meta?.target as string[] | undefined) ?? [];
}

let seq = 0;
function newDocument(overrides: Partial<Prisma.DocumentUncheckedCreateInput> = {}): Prisma.DocumentUncheckedCreateInput {
  seq += 1;
  return {
    source: 'EMAIL',
    externalMessageId: `msg-${seq}`,
    attachmentIndex: 0,
    scopeKey: 'client:client_alnoor',
    contentHash: seq.toString(16).padStart(64, '0'),
    senderRef: 'ap@alnoor.example',
    clientId: 'client_alnoor',
    blobKey: 'blob',
    mimeType: 'application/pdf',
    ...overrides,
  };
}

function matchFor(documentId: string, transactionId: string, status: Prisma.DocumentMatchUncheckedCreateInput['status']) {
  return { documentId, transactionId, score: 0.9, rank: 1, signals: {}, status };
}

describe('one_confirmed_per_txn partial unique index', () => {
  it.each(['AUTO_CONFIRMED', 'CONFIRMED'] as const)('rejects a second %s match on a transaction that is already confirmed', async (status) => {
    // txn_confirmed already holds the seeded CONFIRMED match.
    const doc = await db.document.create({ data: newDocument() });
    const err = await rejection(db.documentMatch.create({ data: matchFor(doc.id, 'txn_confirmed', status) }));
    // This is what application code must catch. The partial index is distinguishable from
    // @@unique([documentId, transactionId]) by its single violated column.
    expect(err.code).toBe('P2002');
    expect(violatedFields(err)).toEqual(['transactionId']);
  });

  it('rejects confirming a second candidate on the same transaction', async () => {
    const [a, b] = await Promise.all([db.document.create({ data: newDocument() }), db.document.create({ data: newDocument() })]);
    const first = await db.documentMatch.create({ data: matchFor(a.id, 'txn_exact', 'CANDIDATE') });
    const second = await db.documentMatch.create({ data: matchFor(b.id, 'txn_exact', 'CANDIDATE') });

    await db.documentMatch.update({ where: { id: first.id }, data: { status: 'CONFIRMED' } });
    const err = await rejection(db.documentMatch.update({ where: { id: second.id }, data: { status: 'AUTO_CONFIRMED' } }));
    expect(err.code).toBe('P2002');
    expect((await db.documentMatch.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('CANDIDATE');
  });

  it('allows many CANDIDATE and REJECTED rows on one transaction', async () => {
    const docs = await Promise.all([1, 2, 3, 4].map(() => db.document.create({ data: newDocument() })));
    const statuses = ['CANDIDATE', 'CANDIDATE', 'REJECTED', 'REJECTED'] as const;
    for (const [i, d] of docs.entries()) {
      await db.documentMatch.create({ data: matchFor(d.id, 'txn_exact', statuses[i]!) });
    }
    expect(await db.documentMatch.count({ where: { transactionId: 'txn_exact' } })).toBe(4);
  });

  it('allows CANDIDATE and REJECTED rows on a transaction that is already confirmed (how possible-duplicate candidates are stored)', async () => {
    const [a, b] = await Promise.all([db.document.create({ data: newDocument() }), db.document.create({ data: newDocument() })]);
    await db.documentMatch.create({ data: matchFor(a.id, 'txn_confirmed', 'CANDIDATE') });
    await db.documentMatch.create({ data: matchFor(b.id, 'txn_confirmed', 'REJECTED') });
    expect(await db.documentMatch.count({ where: { transactionId: 'txn_confirmed' } })).toBe(3);
    expect(await db.documentMatch.count({ where: { transactionId: 'txn_confirmed', status: { in: ['AUTO_CONFIRMED', 'CONFIRMED'] } } })).toBe(1);
  });

  it('allows a new confirmation once the previous confirmed match was rejected', async () => {
    const doc = await db.document.create({ data: newDocument() });
    await db.documentMatch.update({ where: { id: 'match_seed_confirmed' }, data: { status: 'REJECTED' } });
    await db.documentMatch.create({ data: matchFor(doc.id, 'txn_confirmed', 'CONFIRMED') });
    const confirmed = await db.documentMatch.count({ where: { transactionId: 'txn_confirmed', status: { in: ['AUTO_CONFIRMED', 'CONFIRMED'] } } });
    expect(confirmed).toBe(1);
  });

  it('allows one document to hold confirmed matches on different transactions', async () => {
    const doc = await db.document.create({ data: newDocument() });
    await db.documentMatch.create({ data: matchFor(doc.id, 'txn_exact', 'CONFIRMED') });
    await db.documentMatch.create({ data: matchFor(doc.id, 'txn_tip', 'CONFIRMED') });
    expect(await db.documentMatch.count({ where: { documentId: doc.id } })).toBe(2);
  });
});

describe('Document uniqueness', () => {
  it('rejects the same (source, externalMessageId, attachmentIndex)', async () => {
    await db.document.create({ data: newDocument({ externalMessageId: 'dup', attachmentIndex: 0 }) });
    // Different content and scope: only the provider message key collides.
    const err = await rejection(db.document.create({ data: newDocument({ externalMessageId: 'dup', attachmentIndex: 0, scopeKey: 'client:client_desert' }) }));
    expect(err.code).toBe('P2002');
    expect(violatedFields(err)).toEqual(['source', 'externalMessageId', 'attachmentIndex']);
  });

  it('allows the same message id with a different attachmentIndex or a different source', async () => {
    await db.document.create({ data: newDocument({ externalMessageId: 'multi', attachmentIndex: 0 }) });
    await db.document.create({ data: newDocument({ externalMessageId: 'multi', attachmentIndex: 1 }) });
    await db.document.create({ data: newDocument({ externalMessageId: 'multi', attachmentIndex: 0, source: 'WHATSAPP', scopeKey: 'phone:+966501111111' }) });
    expect(await db.document.count({ where: { externalMessageId: 'multi' } })).toBe(3);
  });

  it('rejects the same (scopeKey, contentHash) under a new message id', async () => {
    const first = newDocument();
    await db.document.create({ data: first });
    const err = await rejection(db.document.create({ data: newDocument({ scopeKey: first.scopeKey, contentHash: first.contentHash }) }));
    expect(err.code).toBe('P2002');
  });

  it('allows identical content in a different scope', async () => {
    const first = newDocument();
    await db.document.create({ data: first });
    await db.document.create({ data: newDocument({ scopeKey: 'client:client_desert', contentHash: first.contentHash }) });
    expect(await db.document.count({ where: { contentHash: first.contentHash } })).toBe(2);
  });
});

describe('other uniqueness', () => {
  it('rejects a second DocumentMatch for the same (documentId, transactionId)', async () => {
    const doc = await db.document.create({ data: newDocument() });
    await db.documentMatch.create({ data: matchFor(doc.id, 'txn_exact', 'CANDIDATE') });
    const err = await rejection(db.documentMatch.create({ data: matchFor(doc.id, 'txn_exact', 'CANDIDATE') }));
    expect(err.code).toBe('P2002');
    expect(violatedFields(err)).toEqual(['documentId', 'transactionId']);
  });

  it('rejects a Transaction with a duplicate externalRef', async () => {
    const err = await rejection(
      db.transaction.create({
        data: { clientId: 'client_alnoor', externalRef: 'ext_txn_exact', merchantName: 'X', amountMinor: 1, occurredAt: new Date('2026-10-01T00:00:00Z') },
      }),
    );
    expect(err.code).toBe('P2002');
  });

  it('rejects a second ClientSender with the same email', async () => {
    const err = await rejection(db.clientSender.create({ data: { clientId: 'client_desert', email: 'ap@alnoor.example' } }));
    expect(err.code).toBe('P2002');
  });
});

describe('referential integrity', () => {
  it('refuses to delete a transaction or document that has a confirmed match (Restrict, not Cascade)', async () => {
    expect((await rejection(db.transaction.delete({ where: { id: 'txn_confirmed' } }))).code).toBe('P2003');
    expect((await rejection(db.document.delete({ where: { id: 'doc_seed_confirmed' } }))).code).toBe('P2003');
    expect(await db.documentMatch.count()).toBe(1);
  });

  it('refuses a match pointing at a missing transaction', async () => {
    const doc = await db.document.create({ data: newDocument() });
    expect((await rejection(db.documentMatch.create({ data: matchFor(doc.id, 'txn_missing', 'CANDIDATE') }))).code).toBe('P2003');
  });
});
