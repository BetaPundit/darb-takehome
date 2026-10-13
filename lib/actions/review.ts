'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { confirmMatchCore, rejectMatchCore } from '@/lib/actions/review-core';
import { actionClient } from '@/lib/actions/safe-action';
import { db } from '@/lib/db';

// Not .cuid(): ids are opaque to this layer (the seeded match id is not a cuid).
const input = z.object({ matchId: z.string().min(1) });

export const confirmMatch = actionClient.inputSchema(input).action(async ({ parsedInput }) => {
  const result = await confirmMatchCore(db, parsedInput.matchId);
  revalidatePath('/review');
  return result;
});

export const rejectMatch = actionClient.inputSchema(input).action(async ({ parsedInput }) => {
  const result = await rejectMatchCore(db, parsedInput.matchId);
  revalidatePath('/review');
  return result;
});
