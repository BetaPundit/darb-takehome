import { getWebhookDeps } from '@/lib/container';
import { handleTransactionsWebhook } from '@/lib/webhooks/handlers/transactions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = (req: Request) => handleTransactionsWebhook(req, getWebhookDeps());
