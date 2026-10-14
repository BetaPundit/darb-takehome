import { formatDistanceToNowStrict } from 'date-fns';
import { CircleCheck, CircleDashed, CircleMinus, CircleX, Mail, MessageCircle, TriangleAlert, type LucideIcon } from 'lucide-react';
import { z } from 'zod';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { extractedDocumentSchema, type ExtractedDocument } from '@/lib/extraction/types';
import type { Prisma } from '@/lib/generated/prisma/client';
import { formatMinor } from '@/lib/money';
import { CandidateActions } from './candidate-actions';
import { amountEvidence, cardEvidence, dateEvidence, formatDocumentDate, merchantEvidence, ocrConfidence, type Evidence, type Tone } from './evidence';
import { ALREADY_CONFIRMED_FLAG, formatRiyadh, nextStepText, reasonText } from './labels';

export type ReviewDocument = Prisma.DocumentGetPayload<{ include: { matches: { include: { transaction: true } } } }>;

/** Only what this page reads from the stored breakdown. Anything else, or a different shape, is treated as unknown. */
const signalsSchema = z.object({ merchant: z.number(), flags: z.array(z.string()) });
const parseSignals = (raw: unknown) => {
  const parsed = signalsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

const DOCUMENT_TYPES: Record<ExtractedDocument['documentType'], string> = { RECEIPT: 'Receipt', TAX_INVOICE: 'Tax invoice', UNKNOWN: 'Unreadable document' };

/** Colour is never the only signal: each tone also has its own icon and a visually hidden word. */
const TONES: Record<Tone, { Icon: LucideIcon; cell: string; icon: string; word: string }> = {
  good: { Icon: CircleCheck, cell: 'border-border bg-card', icon: 'text-good', word: 'Matches' },
  partial: { Icon: CircleMinus, cell: 'border-caution/30 bg-caution-soft', icon: 'text-caution', word: 'Partly matches' },
  bad: { Icon: CircleX, cell: 'border-bad/30 bg-bad-soft', icon: 'text-bad', word: 'Does not match' },
  unknown: { Icon: CircleDashed, cell: 'border-dashed border-border bg-transparent', icon: 'text-muted-foreground', word: 'Cannot compare' },
};

function EvidenceCell({ label, evidence }: { label: string; evidence: Evidence }) {
  const { Icon, cell, icon, word } = TONES[evidence.tone];
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${cell}`}>
      <dt className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Icon className={`size-4 ${icon}`} aria-hidden />
        {label}
        <span className="sr-only">: {word}</span>
      </dt>
      <dd className="mt-1 font-medium tabular-nums">{evidence.value}</dd>
      <dd className="text-sm text-muted-foreground">{evidence.note}</dd>
    </div>
  );
}

function FitMeter({ score }: { score: number }) {
  const percent = Math.round(score * 100);
  return (
    <Tooltip>
      <TooltipTrigger render={<div tabIndex={0} className="w-28 shrink-0 cursor-help rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50" />}>
        <Progress value={percent} aria-label={`Fit ${percent}%`} className="gap-1">
          <span className="ml-auto text-sm font-semibold tabular-nums">{percent}% fit</span>
        </Progress>
      </TooltipTrigger>
      <TooltipContent>How closely this transaction fits the receipt, from the amount, the name, the date and the card.</TooltipContent>
    </Tooltip>
  );
}

function CandidateRow({ match, document }: { match: ReviewDocument['matches'][number]; document: ExtractedDocument | null }) {
  const txn = match.transaction;
  const signals = parseSignals(match.signals);
  const flags = signals?.flags ?? [];
  const possibleDuplicate = flags.includes(ALREADY_CONFIRMED_FLAG);

  return (
    <li className="space-y-3 border-t p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-medium" dir="auto">
            {txn.merchantName}
          </p>
          <p className="text-sm text-muted-foreground">{formatRiyadh(txn.occurredAt)}</p>
        </div>
        <FitMeter score={match.score} />
      </div>

      {document ? (
        <dl className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <EvidenceCell label="Amount" evidence={amountEvidence(document.totalAmount, txn, flags)} />
          <EvidenceCell label="Merchant" evidence={merchantEvidence(signals?.merchant ?? null)} />
          <EvidenceCell label="Date" evidence={dateEvidence(document.documentDate, txn.occurredAt)} />
          <EvidenceCell label="Card" evidence={cardEvidence(document.cardLast4, txn.cardLast4)} />
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">The receipt data cannot be read, so this candidate cannot be compared.</p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        {possibleDuplicate ? (
          <p className="flex max-w-prose items-start gap-2 rounded-lg bg-caution-soft px-3 py-2 text-sm text-caution">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              <strong className="font-semibold">Possible duplicate.</strong> This transaction already has a confirmed document. If this is another copy of the same receipt, reject it.
            </span>
          </p>
        ) : (
          <span />
        )}
        <CandidateActions matchId={match.id} merchant={txn.merchantName} possibleDuplicate={possibleDuplicate} />
      </div>
    </li>
  );
}

function Facts({ document }: { document: ExtractedDocument }) {
  const facts: [string, string][] = [];
  if (document.invoiceNumber) facts.push(['Invoice', document.invoiceNumber]);
  if (document.vatNumber) facts.push(['VAT number', document.vatNumber]);
  if (document.cardLast4) facts.push(['Card', `•••• ${document.cardLast4}`]);
  if (facts.length === 0) return null;
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
      {facts.map(([k, v]) => (
        <div key={k} className="flex gap-1.5">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="font-medium tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ReviewDocumentCard({ doc, actionable }: { doc: ReviewDocument; actionable: boolean }) {
  const parsed = extractedDocumentSchema.safeParse(doc.extraction);
  const extracted = parsed.success ? parsed.data : null;
  const candidates = [...doc.matches].sort((a, b) => a.rank - b.rank);
  const SourceIcon = doc.source === 'EMAIL' ? Mail : MessageCircle;
  const ocr = extracted ? ocrConfidence(extracted.extractionConfidence) : null;
  const nextStep = actionable ? null : nextStepText(doc.matchReason);

  return (
    <Card className="gap-0 py-0">
      <header className="space-y-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1.5">
            <SourceIcon className="size-4 shrink-0" aria-label={doc.source === 'EMAIL' ? 'Email' : 'WhatsApp'} />
            <span className="truncate">{doc.senderRef}</span>
          </span>
          <time dateTime={doc.receivedAt.toISOString()} title={formatRiyadh(doc.receivedAt)}>
            Received {formatDistanceToNowStrict(doc.receivedAt, { addSuffix: true })}
          </time>
        </div>

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold leading-snug" dir="auto">
              {extracted?.merchantName ?? 'Unreadable document'}
            </h2>
            <p className="text-sm text-muted-foreground">{extracted ? `${DOCUMENT_TYPES[extracted.documentType]}, ${formatDocumentDate(extracted.documentDate)}` : 'Extracted data is missing or unreadable.'}</p>
          </div>
          {extracted?.totalAmount != null && <p className="shrink-0 text-2xl font-semibold tabular-nums">{formatMinor(extracted.totalAmount, extracted.currency ?? 'SAR')}</p>}
        </div>

        <p className="text-sm">{reasonText(doc.matchReason)}.</p>
        {nextStep && <p className="text-sm text-muted-foreground">{nextStep}</p>}

        {extracted && <Facts document={extracted} />}

        {ocr?.low && (
          <p className="flex items-center gap-2 rounded-lg bg-caution-soft px-3 py-2 text-sm text-caution">
            <TriangleAlert className="size-4 shrink-0" aria-hidden />
            The OCR was only {ocr.percent}% sure of what it read. Check the receipt itself before confirming.
          </p>
        )}

        {extracted?.rawText && (
          <details className="group text-sm">
            <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">
              Show what the OCR read{ocr && !ocr.low ? ` (${ocr.percent}% sure)` : ''}
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 font-sans" dir="auto">
              {extracted.rawText}
            </pre>
          </details>
        )}
      </header>

      {actionable &&
        (candidates.length === 0 ? (
          <p className="border-t p-5 text-sm text-muted-foreground">No open candidates.</p>
        ) : (
          <ul aria-label="Candidate transactions">
            {candidates.map((m) => (
              <CandidateRow key={m.id} match={m} document={extracted} />
            ))}
          </ul>
        ))}
    </Card>
  );
}
