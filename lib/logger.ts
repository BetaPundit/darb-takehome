/** Structured JSON logs. Callers pass ids, outcomes and counts only: never document text, bytes or phone numbers. */
export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

const write = (level: string, event: string, fields?: Record<string, unknown>) =>
  console.log(JSON.stringify({ level, event, ...fields }));

export const consoleLogger: Logger = {
  info: (event, fields) => write('info', event, fields),
  warn: (event, fields) => write('warn', event, fields),
  error: (event, fields) => write('error', event, fields),
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
