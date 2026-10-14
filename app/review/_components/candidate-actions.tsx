'use client';

import { useAction } from 'next-safe-action/hooks';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { confirmMatch, rejectMatch } from '@/lib/actions/review';

/**
 * Buttons lock while either action runs. That only stops accidental double clicks; the server is
 * idempotent and is the real guarantee.
 *
 * A possible duplicate (its transaction already has a confirmed document) cannot be confirmed, so there is no Confirm
 * button for it; the server refuses it anyway (TRANSACTION_ALREADY_CONFIRMED). Reject stays.
 *
 * A decision removes the document from the queue, so a toast says what just happened. Errors stay on screen next to the
 * buttons instead: they need an action from the reviewer, a toast would disappear.
 */
export function CandidateActions({ matchId, merchant, possibleDuplicate = false }: { matchId: string; merchant: string; possibleDuplicate?: boolean }) {
  const confirm = useAction(confirmMatch, {
    onSuccess: ({ data }) => toast.success(data?.alreadyConfirmed ? 'Already confirmed' : 'Confirmed', { description: `Receipt matched to ${merchant}.` }),
  });
  const reject = useAction(rejectMatch, {
    onSuccess: () => toast.success('Rejected', { description: `${merchant} will not be suggested for this receipt again.` }),
  });
  const busy = confirm.isExecuting || reject.isExecuting;
  const error = confirm.result.serverError ?? reject.result.serverError;
  const invalid = confirm.result.validationErrors ?? reject.result.validationErrors;

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => reject.execute({ matchId })}>
          {reject.isExecuting ? 'Rejecting…' : 'Reject'}
        </Button>
        {!possibleDuplicate && (
          <Button size="sm" disabled={busy} onClick={() => confirm.execute({ matchId })}>
            {confirm.isExecuting ? 'Confirming…' : 'Confirm'}
          </Button>
        )}
      </div>
      {(error || invalid) && (
        <p role="alert" className="max-w-64 text-wrap text-right text-sm text-destructive">
          {error?.message ?? 'Invalid request'}
        </p>
      )}
    </div>
  );
}
