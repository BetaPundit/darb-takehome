import { createLogger, errorFields } from '@/lib/logger';

const NOW = new Date('2026-10-14T09:08:07.123Z');
function setup(opts: Parameters<typeof createLogger>[0] = {}) {
  const lines: Array<{ level: string; line: string }> = [];
  const logger = createLogger({ now: () => NOW, write: (level, line) => lines.push({ level, line }), colors: false, ...opts });
  return { logger, lines };
}

describe('logger: JSON format', () => {
  it('emits one JSON object per line with an ISO timestamp, level, event and fields', () => {
    const { logger, lines } = setup({ pretty: false });
    logger.info('document.processed', { documentId: 'd1', durationMs: 12 });
    expect(JSON.parse(lines[0]!.line)).toEqual({ time: '2026-10-14T09:08:07.123Z', level: 'info', event: 'document.processed', documentId: 'd1', durationMs: 12 });
  });

  it('routes warn and error to the error stream and info to the output stream', () => {
    const { logger, lines } = setup({ pretty: false });
    logger.info('a');
    logger.warn('b');
    logger.error('c');
    expect(lines.map((l) => l.level)).toEqual(['info', 'warn', 'error']);
  });

  it('child loggers add bindings to every line, and later fields win over bindings', () => {
    const { logger, lines } = setup({ pretty: false });
    const child = logger.child({ requestId: 'r1', endpoint: 'email' }).child({ extra: 1 });
    child.info('x', { endpoint: 'override' });
    expect(JSON.parse(lines[0]!.line)).toMatchObject({ requestId: 'r1', extra: 1, endpoint: 'override' });
  });
});

describe('logger: level filter', () => {
  it.each([
    ['info', ['info', 'warn', 'error']],
    ['warn', ['warn', 'error']],
    ['error', ['error']],
  ] as const)('level %s emits %j', (level, expected) => {
    const { logger, lines } = setup({ level, pretty: false });
    logger.info('a');
    logger.warn('b');
    logger.error('c');
    expect(lines.map((l) => l.level)).toEqual(expected);
  });
});

describe('logger: pretty format (development)', () => {
  it('prints time, padded level, event and key=value fields on one readable line', () => {
    const { logger, lines } = setup({ pretty: true });
    logger.info('document.processed', { documentId: 'd1', outcome: 'AUTO_MATCHED', durationMs: 12 });
    // the clock is formatted in local time; assert the stable parts
    expect(lines[0]!.line).toMatch(/^\d{2}:\d{2}:\d{2}\.123 INFO {2}document\.processed {2}documentId=d1 outcome=AUTO_MATCHED durationMs=12$/);
  });

  it('quotes values with spaces and renders objects as JSON', () => {
    const { logger, lines } = setup({ pretty: true });
    logger.warn('x', { reason: 'two words', list: [1, 2] });
    expect(lines[0]!.line).toContain('reason="two words"');
    expect(lines[0]!.line).toContain('list=[1,2]');
    expect(lines[0]!.line).toContain('WARN ');
  });

  it('adds ANSI colours only when asked to (never in piped or CI output)', () => {
    const plain = setup({ pretty: true, colors: false });
    plain.logger.error('boom');
    expect(plain.lines[0]!.line).not.toContain('\u001b[');
    const coloured = setup({ pretty: true, colors: true });
    coloured.logger.error('boom');
    expect(coloured.lines[0]!.line).toContain('\u001b[');
  });
});

describe('logger: defence in depth against logging sensitive data', () => {
  it('redacts known-sensitive field names whatever the caller passes', () => {
    const { logger, lines } = setup({ pretty: false });
    logger.info('x', {
      rawText: 'TOTAL 187.50',
      phone: '+966501111111',
      email: 'ap@alnoor.example',
      Authorization: 'Bearer abc',
      signature: 'sha256=abc',
      contentBase64: 'AAAA',
      ok: 'fine',
    });
    const out = lines[0]!.line;
    for (const secret of ['TOTAL 187.50', '+966501111111', 'ap@alnoor.example', 'Bearer abc', 'sha256=abc', 'AAAA']) expect(out).not.toContain(secret);
    expect(JSON.parse(out)).toMatchObject({ rawText: '[redacted]', phone: '[redacted]', ok: 'fine' });
  });

  it('never serialises Error objects or Buffers verbatim', () => {
    const { logger, lines } = setup({ pretty: false });
    logger.error('x', { err: new Error('contains SECRET document text'), blob: Buffer.from('SECRET-BYTES') });
    expect(lines[0]!.line).not.toContain('SECRET');
  });

  it('does not throw on circular values: logging must never break a request', () => {
    const { logger, lines } = setup({ pretty: false });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => logger.info('x', { circular })).not.toThrow();
    expect(lines).toHaveLength(1);
  });
});

describe('errorFields', () => {
  it('keeps the error class and a short machine code, never the message', () => {
    const err = Object.assign(new Error('Invalid prisma.document.create() invocation: contentHash "SECRET"'), { code: 'P2002' });
    expect(errorFields(err)).toEqual({ error: 'Error', code: 'P2002' });
  });

  it('drops codes that are not short identifiers (could be free text)', () => {
    expect(errorFields(Object.assign(new Error('x'), { code: 'some free text with SECRET' }))).toEqual({ error: 'Error' });
  });

  it('handles non-Error throwables', () => {
    expect(errorFields('a string with SECRET')).toEqual({ error: 'unknown' });
    expect(errorFields(undefined)).toEqual({ error: 'unknown' });
  });
});
