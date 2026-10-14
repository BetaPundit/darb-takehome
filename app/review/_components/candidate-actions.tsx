'use client';

import { useAction } from 'next-safe-action/hooks';
import { confirmMatch, rejectMatch } from '@/lib/actions/review';
import { Button } from '@/components/ui/button';
import { ALREADY_CONFIRMED_FLAG, flagText } from './labels';

/**
 * Buttons lock while either action runs. That only stops accidental double clicks; the server is
 * idempotent and is the real guarantee.
 *
 * A possible duplicate (its transaction already has a confirmed document) cannot be confirmed, so there is no Confirm
 * button for it; the server refuses it anyway (TRANSACTION_ALREADY_CONFIRMED). Reject stays.
 */
export function CandidateActions({ matchId, possibleDuplicate = false }: { matchId: string; possibleDuplicate?: boolean }) {
  const confirm = useAction(confirmMatch);
  const reject = useAction(rejectMatch);
  const busy = confirm.isExecuting || reject.isExecuting;
  const error = confirm.result.serverError ?? reject.result.serverError;
  const invalid = confirm.result.validationErrors ?? reject.result.validationErrors;

  return (
    <div className="flex flex-col items-end gap-1">
      {possibleDuplicate && <p className="max-w-56 text-wrap text-right text-xs font-medium text-destructive">{flagText(ALREADY_CONFIRMED_FLAG)}</p>}
      <div className="flex gap-2">
        {!possibleDuplicate && (
          <Button size="sm" disabled={busy} onClick={() => confirm.execute({ matchId })}>
            {confirm.isExecuting ? 'Confirming…' : 'Confirm'}
          </Button>
        )}
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
