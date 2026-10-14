import { formatDistanceToNowStrict } from 'date-fns';
import { CircleCheck, Inbox } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { db } from '@/lib/prisma';
import { ReviewDocumentCard } from './_components/review-document';

export const dynamic = 'force-dynamic';

function EmptyState({ icon: Icon, title, children }: { icon: typeof Inbox; title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed bg-card/50 px-6 py-14 text-center">
      <Icon className="size-8 text-muted-foreground" aria-hidden />
      <p className="font-medium">{title}</p>
      <p className="max-w-sm text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

export default async function ReviewPage() {
  // One query: documents with only their open candidates and each candidate's transaction.
  const docs = await db.document.findMany({
    where: { status: { in: ['NEEDS_REVIEW', 'UNMATCHED'] } },
    orderBy: { receivedAt: 'asc' },
    include: { matches: { where: { status: 'CANDIDATE' }, orderBy: { rank: 'asc' }, include: { transaction: true } } },
  });
  const needsReview = docs.filter((d) => d.status === 'NEEDS_REVIEW');
  const unmatched = docs.filter((d) => d.status === 'UNMATCHED');
  const oldest = needsReview[0];

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Review queue</h1>
        <p className="text-muted-foreground">
          {needsReview.length === 0
            ? 'Every document has a decision.'
            : `${needsReview.length === 1 ? '1 document needs' : `${needsReview.length} documents need`} a decision. The oldest arrived ${formatDistanceToNowStrict(oldest!.receivedAt, { addSuffix: true })}.`}
        </p>
      </header>

      {/* The tab panels are server-rendered; only the tab switching is client-side. */}
      <Tabs defaultValue="needs-review">
        <TabsList>
          <TabsTrigger value="needs-review" className="gap-2">
            Needs review <Badge variant="secondary">{needsReview.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="unmatched" className="gap-2">
            Unmatched <Badge variant="secondary">{unmatched.length}</Badge>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="needs-review" className="space-y-4 pt-3">
          {needsReview.length === 0 && (
            <EmptyState icon={CircleCheck} title="Nothing waiting for you">
              New receipts that the matcher cannot attach on its own will appear here.
            </EmptyState>
          )}
          {needsReview.map((d) => (
            <ReviewDocumentCard key={d.id} doc={d} actionable />
          ))}
        </TabsContent>

        <TabsContent value="unmatched" className="space-y-4 pt-3">
          {unmatched.length === 0 && (
            <EmptyState icon={Inbox} title="No unmatched documents">
              Documents with no plausible transaction are listed here, and are matched again automatically when new transactions arrive.
            </EmptyState>
          )}
          {unmatched.map((d) => (
            <ReviewDocumentCard key={d.id} doc={d} actionable={false} />
          ))}
        </TabsContent>
      </Tabs>
    </main>
  );
}
