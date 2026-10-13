import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { extractedDocumentSchema } from '@/lib/extraction/types';
import type { Prisma } from '@/lib/generated/prisma/client';
import { formatMinor } from '@/lib/money';
import { CandidateActions } from './candidate-actions';
import { flagText, formatRiyadh, reasonText } from './labels';

export type ReviewDocument = Prisma.DocumentGetPayload<{ include: { matches: { include: { transaction: true } } } }>;

const signalsSchema = z.object({
  amount: z.number(),
  merchant: z.number(),
  date: z.number(),
  card: z.number().nullable(),
  flags: z.array(z.string()),
});

const pct = (n: number) => `${Math.round(n * 100)}%`;

function Extracted({ extraction }: { extraction: unknown }) {
  const parsed = extractedDocumentSchema.safeParse(extraction);
  if (!parsed.success) {
    return <p className="text-sm text-muted-foreground">Extracted data is missing or unreadable.</p>;
  }
  const e = parsed.data;
  const fields: [string, string][] = [
    ['Merchant', e.merchantName ?? 'unknown'],
    ['Amount', e.amountMinor === null ? 'unknown' : formatMinor(e.amountMinor, e.currency ?? 'SAR')],
    ['Date', e.documentDate ?? 'unknown'],
    ['Card last 4', e.cardLast4 ?? 'none'],
    ['Invoice no.', e.invoiceNumber ?? 'none'],
    ['VAT no.', e.vatNumber ?? 'none'],
    ['Type', e.documentType],
    ['OCR confidence', pct(e.confidence)],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
      {fields.map(([k, v]) => (
        <div key={k}>
          <dt className="text-xs text-muted-foreground">{k}</dt>
          <dd className="font-medium">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Breakdown({ signals }: { signals: unknown }) {
  const parsed = signalsSchema.safeParse(signals);
  if (!parsed.success) return <span className="text-muted-foreground">n/a</span>;
  const s = parsed.data;
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">
        amount {pct(s.amount)} · merchant {pct(s.merchant)} · date {pct(s.date)} · card {s.card === null ? 'n/a' : pct(s.card)}
      </div>
      {s.flags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {s.flags.map((f) => (
            <Badge key={f} variant="outline" className="h-auto whitespace-normal">
              {flagText(f)}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

export function ReviewDocumentCard({ doc, actionable }: { doc: ReviewDocument; actionable: boolean }) {
  const candidates = [...doc.matches].sort((a, b) => a.rank - b.rank);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{doc.source === 'EMAIL' ? 'Email' : 'WhatsApp'}</Badge>
          <span className="break-all">{doc.senderRef}</span>
        </CardTitle>
        <CardDescription>
          Received {formatRiyadh(doc.receivedAt)} · {reasonText(doc.matchReason)}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Extracted extraction={doc.extraction} />
        {actionable &&
          (candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">No open candidates.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Merchant</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Score</TableHead>
                  <TableHead>Why</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {candidates.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell>{m.transaction.merchantName}</TableCell>
                    <TableCell>{formatMinor(m.transaction.amountMinor, m.transaction.currency)}</TableCell>
                    <TableCell>{formatRiyadh(m.transaction.occurredAt)}</TableCell>
                    <TableCell className="font-medium">{pct(m.score)}</TableCell>
                    <TableCell className="whitespace-normal">
                      <Breakdown signals={m.signals} />
                    </TableCell>
                    <TableCell>
                      <CandidateActions matchId={m.id} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ))}
      </CardContent>
    </Card>
  );
}
