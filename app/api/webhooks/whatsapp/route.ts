import { getWebhookDeps } from '@/lib/container';
import { handleWhatsAppVerify, handleWhatsAppWebhook } from '@/lib/webhooks/handlers/whatsapp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = (req: Request) => handleWhatsAppVerify(req, getWebhookDeps());
export const POST = (req: Request) => handleWhatsAppWebhook(req, getWebhookDeps());
