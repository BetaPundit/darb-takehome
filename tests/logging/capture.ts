import type { Logger, LogFields } from '@/lib/logger';

export interface Entry {
  level: 'info' | 'warn' | 'error';
  event: string;
  fields: LogFields; // bindings from child() loggers already merged in
}

/** A Logger that records everything, applying child() bindings like the real one. */
export function createCapturingLogger(entries: Entry[] = [], bindings: LogFields = {}): Logger & { entries: Entry[] } {
  const rec = (level: Entry['level']) => (event: string, fields?: LogFields) => void entries.push({ level, event, fields: { ...bindings, ...fields } });
  return {
    entries,
    info: rec('info'),
    warn: rec('warn'),
    error: rec('error'),
    child: (more) => createCapturingLogger(entries, { ...bindings, ...more }),
  };
}
