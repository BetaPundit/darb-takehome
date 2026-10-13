import { z } from 'zod';

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Empty string means "unset" (`.env.example` ships `FOO=""`), so defaults and required-checks apply. */
const optionalString = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());

const rawEnvSchema = z.object({
  NODE_ENV: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['development', 'test', 'production']).default('development'),
  ),
  DATABASE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().default('file:./dev.db')),
  EMAIL_WEBHOOK_SECRET: optionalString,
  WHATSAPP_APP_SECRET: optionalString,
  TRANSACTIONS_WEBHOOK_SECRET: optionalString,
  WHATSAPP_VERIFY_TOKEN: optionalString,
  WHATSAPP_ACCESS_TOKEN: optionalString,
  EXTRACTOR: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['mock', 'claude']).default('mock')),
  ANTHROPIC_API_KEY: optionalString,
  BLOB_DIR: z.preprocess((v) => (v === '' ? undefined : v), z.string().default('./data/blobs')),
  MAX_BODY_BYTES: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().default(DEFAULT_MAX_BODY_BYTES),
  ),
});

type RawEnv = z.infer<typeof rawEnvSchema>;

const PRODUCTION_REQUIRED = [
  'EMAIL_WEBHOOK_SECRET',
  'WHATSAPP_APP_SECRET',
  'TRANSACTIONS_WEBHOOK_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
] as const satisfies readonly (keyof RawEnv)[];

export interface Env extends RawEnv {
  /** false => the route must skip signature verification (allowed outside production only); log a warning. */
  signatureCheckEnabled: { email: boolean; whatsapp: boolean; transactions: boolean };
}

export class EnvError extends Error {
  constructor(readonly problems: string[]) {
    // Variable names and messages only, never values (they may be secrets).
    super(`Invalid environment: ${problems.join('; ')}`);
    this.name = 'EnvError';
  }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const parsed = rawEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new EnvError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const env = parsed.data;

  const problems: string[] = [];
  if (env.NODE_ENV === 'production') {
    for (const key of PRODUCTION_REQUIRED) {
      if (!env[key]) problems.push(`${key}: required in production`);
    }
  }
  if (env.EXTRACTOR === 'claude' && !env.ANTHROPIC_API_KEY) {
    problems.push('ANTHROPIC_API_KEY: required when EXTRACTOR=claude');
  }
  if (problems.length > 0) throw new EnvError(problems);

  return {
    ...env,
    signatureCheckEnabled: {
      email: Boolean(env.EMAIL_WEBHOOK_SECRET),
      whatsapp: Boolean(env.WHATSAPP_APP_SECRET),
      transactions: Boolean(env.TRANSACTIONS_WEBHOOK_SECRET),
    },
  };
}

let cached: Env | undefined;

/** Lazy and memoized: reads process.env on first call only, so importing this never throws (e.g. during `next build`). */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
