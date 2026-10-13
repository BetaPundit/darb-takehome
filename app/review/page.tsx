import { db } from '@/lib/db';
import { ReviewDocumentCard } from './_components/review-document';

export const dynamic = 'force-dynamic';

export default async function ReviewPage() {
  // One query: documents with only their open candidates and each candidate's transaction.
  const docs = await db.document.findMany({
    where: { status: { in: ['NEEDS_REVIEW', 'UNMATCHED'] } },
    orderBy: { receivedAt: 'asc' },
    include: { matches: { where: { status: 'CANDIDATE' }, orderBy: { rank: 'asc' }, include: { transaction: true } } },
  });
  const needsReview = docs.filter((d) => d.status === 'NEEDS_REVIEW');
  const unmatched = docs.filter((d) => d.status === 'UNMATCHED');

  return (
    <main className="mx-auto max-w-5xl space-y-10 p-6">
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold">Needs review ({needsReview.length})</h1>
        {needsReview.length === 0 && <p className="text-muted-foreground">Nothing to review.</p>}
        {needsReview.map((d) => (
          <ReviewDocumentCard key={d.id} doc={d} actionable />
        ))}
      </section>
      <section className="space-y-4">
        <h2 className="text-xl font-semibold">Unmatched ({unmatched.length})</h2>
        {unmatched.length === 0 && <p className="text-muted-foreground">No unmatched documents.</p>}
        {unmatched.map((d) => (
          <ReviewDocumentCard key={d.id} doc={d} actionable={false} />
        ))}
      </section>
    </main>
  );
}
