/**
 * Structured logging. The rule for callers: ids, outcomes, counts, durations and short codes only. Never document
 * text, bytes, phone numbers, email addresses, tokens or error MESSAGES (Prisma and provider errors can echo
 * submitted data). The logger enforces part of this itself (see SENSITIVE_KEYS) as defence in depth.
 */
export type LogFields = Record<string, unknown>;
export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger that adds `bindings` (e.g. requestId) to every line. */
  child(bindings: LogFields): Logger;
}

const ORDER: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };

/** Field names that must never reach a log line, whatever the caller passes. Matched case-insensitively. */
const SENSITIVE_KEYS = new Set([
  'rawtext', 'bytes', 'body', 'contentbase64', 'extraction',
  'phone', 'driverphone', 'senderref', 'email', 'from', 'merchantname',
  'token', 'accesstoken', 'secret', 'signature', 'authorization', 'apikey',
]);

/** Error class + a short machine code (Prisma P2002, ExtractionError TIMEOUT...). Never the message. */
export function errorFields(err: unknown): { error: string; code?: string } {
  if (!(err instanceof Error)) return { error: 'unknown' };
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code) ? { error: err.name, code } : { error: err.name };
}

function sanitize(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) out[key] = '[redacted]';
    else if (value instanceof Error) out[key] = errorFields(value);
    else if (Buffer.isBuffer(value)) out[key] = `[${value.length} bytes]`;
    else out[key] = value;
  }
  return out;
}

const COLORS: Record<LogLevel, string> = { info: '\u001b[36m', warn: '\u001b[33m', error: '\u001b[31m' };
const DIM = '\u001b[2m';
const RESET = '\u001b[0m';

function prettyValue(value: unknown): string {
  if (typeof value === 'string') return /[\s"=]/.test(value) ? JSON.stringify(value) : value;
  if (typeof value === 'object' && value !== null) return safeStringify(value);
  return String(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserialisable]"'; // logging must never throw into a request
  }
}

function pad2(n: number, width = 2) {
  return String(n).padStart(width, '0');
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Human-readable single lines (development) instead of JSON lines (production). */
  pretty?: boolean;
  colors?: boolean;
  now?: () => Date;
  /** Output sink. Default: stdout for info, stderr for warn and error. */
  write?: (level: LogLevel, line: string) => void;
  bindings?: LogFields;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? 'info';
  const pretty = opts.pretty ?? false;
  const colors = opts.colors ?? false;
  const now = opts.now ?? (() => new Date());
  const write = opts.write ?? ((l, line) => (l === 'info' ? console.log(line) : console.error(line)));
  const bindings = opts.bindings ?? {};

  function emit(lvl: LogLevel, event: string, fields: LogFields = {}) {
    if (ORDER[lvl] < ORDER[level]) return;
    const clean = sanitize({ ...bindings, ...fields });
    const time = now();
    if (!pretty) {
      write(lvl, safeStringify({ time: time.toISOString(), level: lvl, event, ...clean }));
      return;
    }
    const clock = `${pad2(time.getHours())}:${pad2(time.getMinutes())}:${pad2(time.getSeconds())}.${pad2(time.getMilliseconds(), 3)}`;
    const tag = lvl.toUpperCase().padEnd(5);
    const kv = Object.entries(clean).map(([k, v]) => `${k}=${prettyValue(v)}`).join(' ');
    const head = colors ? `${DIM}${clock}${RESET} ${COLORS[lvl]}${tag}${RESET} ${event}` : `${clock} ${tag} ${event}`;
    write(lvl, kv ? `${head}  ${kv}` : head);
  }

  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    child: (more) => createLogger({ ...opts, bindings: { ...bindings, ...more } }),
  };
}

function levelFromEnv(value: string | undefined): LogLevel {
  return value === 'warn' || value === 'error' ? value : 'info';
}

/**
 * Default logger. LOG_LEVEL=info|warn|error (default info). Pretty output in `next dev`, JSON lines otherwise;
 * override with LOG_FORMAT=pretty|json. Colours only when attached to a terminal and NO_COLOR is not set.
 */
export const consoleLogger: Logger = createLogger({
  level: levelFromEnv(process.env.LOG_LEVEL),
  pretty: process.env.LOG_FORMAT ? process.env.LOG_FORMAT === 'pretty' : process.env.NODE_ENV === 'development',
  colors: Boolean(process.stdout?.isTTY) && !process.env.NO_COLOR,
});

const noop = () => {};
export const silentLogger: Logger = { info: noop, warn: noop, error: noop, child: () => silentLogger };
