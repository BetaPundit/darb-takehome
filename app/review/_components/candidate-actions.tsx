'use client';

import { useAction } from 'next-safe-action/hooks';
import { confirmMatch, rejectMatch } from '@/lib/actions/review';
import { Button } from '@/components/ui/button';

/**
 * Buttons lock while either action runs. That only stops accidental double clicks; the server is
 * idempotent and is the real guarantee.
 */
export function CandidateActions({ matchId }: { matchId: string }) {
  const confirm = useAction(confirmMatch);
  const reject = useAction(rejectMatch);
  const busy = confirm.isExecuting || reject.isExecuting;
  const error = confirm.result.serverError ?? reject.result.serverError;
  const invalid = confirm.result.validationErrors ?? reject.result.validationErrors;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => confirm.execute({ matchId })}>
          {confirm.isExecuting ? 'Confirming…' : 'Confirm'}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => reject.execute({ matchId })}>
          {reject.isExecuting ? 'Rejecting…' : 'Reject'}
        </Button>
      </div>
      {(error || invalid) && (
        <p role="alert" className="max-w-64 text-wrap text-right text-xs text-destructive">
          {error?.message ?? 'Invalid request'}
        </p>
      )}
    </div>
  );
}
