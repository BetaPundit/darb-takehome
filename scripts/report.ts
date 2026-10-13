import 'dotenv/config';
import { createPrismaClient } from '@/lib/prisma-client';

/** Prints every document with its outcome. Used by send-fixtures.sh; read-only. */
async function main() {
  const db = createPrismaClient();
  const docs = await db.document.findMany({
    orderBy: { receivedAt: 'asc' },
    include: { matches: { orderBy: { rank: 'asc' } } },
  });
  const rows = docs.map((d) => ({
    source: d.source,
    scope: d.scopeKey.replace('client:client_', 'client:'),
    merchant: (d.extraction as { merchantName?: string | null } | null)?.merchantName?.slice(0, 26) ?? '-',
    status: d.status,
    reason: d.failureReason ?? d.matchReason ?? '-',
    matches: d.matches.filter((m) => m.status !== 'REJECTED').map((m) => `${m.transactionId}:${m.status}`).join(' ') || '-',
  }));
  console.table(rows);
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
