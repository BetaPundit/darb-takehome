'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { confirmMatchCore, rejectMatchCore } from '@/lib/actions/review-core';
import { actionClient } from '@/lib/actions/safe-action-client';
import { db } from '@/lib/prisma';
import { consoleLogger } from '@/lib/logger';

// Not .cuid(): ids are opaque to this layer (the seeded match id is not a cuid).
const input = z.object({ matchId: z.string().min(1) });

export const confirmMatch = actionClient.inputSchema(input).action(async ({ parsedInput }) => {
  const result = await confirmMatchCore(db, parsedInput.matchId);
  consoleLogger.info('review.decided', { action: 'confirm', matchId: result.matchId, documentId: result.documentId, transactionId: result.transactionId, alreadyConfirmed: result.alreadyConfirmed });
  revalidatePath('/review');
  return result;
});

export const rejectMatch = actionClient.inputSchema(input).action(async ({ parsedInput }) => {
  const result = await rejectMatchCore(db, parsedInput.matchId);
  consoleLogger.info('review.decided', { action: 'reject', matchId: result.matchId, documentStatus: result.documentStatus });
  revalidatePath('/review');
  return result;
});
