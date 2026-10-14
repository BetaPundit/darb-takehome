import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { db } from '@/lib/prisma';
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
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">Review</h1>
      {/* The tab panels are server-rendered; only the tab switching is client-side. */}
      <Tabs defaultValue="needs-review">
        <TabsList>
          <TabsTrigger value="needs-review">Needs review ({needsReview.length})</TabsTrigger>
          <TabsTrigger value="unmatched">Unmatched ({unmatched.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="needs-review" className="space-y-4 pt-2">
          {needsReview.length === 0 && <p className="text-muted-foreground">Nothing to review.</p>}
          {needsReview.map((d) => (
            <ReviewDocumentCard key={d.id} doc={d} actionable />
          ))}
        </TabsContent>
        <TabsContent value="unmatched" className="space-y-4 pt-2">
          {unmatched.length === 0 && <p className="text-muted-foreground">No unmatched documents.</p>}
          {unmatched.map((d) => (
            <ReviewDocumentCard key={d.id} doc={d} actionable={false} />
          ))}
        </TabsContent>
      </Tabs>
    </main>
  );
}
