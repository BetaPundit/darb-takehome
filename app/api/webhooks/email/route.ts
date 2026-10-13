import { getWebhookDeps } from '@/lib/container';
import { handleEmailWebhook } from '@/lib/webhooks/handlers/email';

export const runtime = 'nodejs'; // better-sqlite3, fs and crypto need Node, not the edge runtime
export const dynamic = 'force-dynamic';

export const POST = (req: Request) => handleEmailWebhook(req, getWebhookDeps());
