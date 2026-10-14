import { createSafeActionClient } from 'next-safe-action';
import { toClientError } from '@/lib/actions/review-core';

/** Shared client for server actions. Errors reach the browser only as ClientError (see toClientError). */
export const actionClient = createSafeActionClient({ handleServerError: (err) => toClientError(err) });
