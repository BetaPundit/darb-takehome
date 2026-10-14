import { createHmac } from 'node:crypto';
import { constantTimeEqual, signPayload, verifySignature } from '@/lib/webhooks/hmac';

const secret = 'It is a secret';
const body = '{"a": 1,  "b":[1, 2]}';

describe('signPayload', () => {
  it('matches the RFC 4231 test case 2 vector', () => {
    // key "Jefe", data "what do ya want for nothing?"
    expect(signPayload('what do ya want for nothing?', 'Jefe')).toBe(
      'sha256=5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('accepts Buffer and string identically', () => {
    expect(signPayload(Buffer.from(body), secret)).toBe(signPayload(body, secret));
  });
});

describe('verifySignature', () => {
  const header = signPayload(body, secret);

  it('accepts a correct signature (string and Buffer bodies)', () => {
    expect(verifySignature({ rawBody: body, header, secret })).toBe('valid');
    expect(verifySignature({ rawBody: Buffer.from(body), header, secret })).toBe('valid');
  });

  it('accepts uppercase hex (hex is case-insensitive)', () => {
    const upper = `sha256=${header.slice('sha256='.length).toUpperCase()}`;
    expect(verifySignature({ rawBody: body, header: upper, secret })).toBe('valid');
  });

  it('rejects a tampered body', () => {
    expect(verifySignature({ rawBody: `${body} `, header, secret })).toBe('invalid');
  });

  it('rejects a wrong secret', () => {
    expect(verifySignature({ rawBody: body, header, secret: 'other' })).toBe('invalid');
  });

  it('rejects a missing header when a secret is configured', () => {
    expect(verifySignature({ rawBody: body, header: null, secret })).toBe('invalid');
    expect(verifySignature({ rawBody: body, header: '', secret })).toBe('invalid');
  });

  it.each([
    ['no prefix', 'abcdef'],
    ['wrong algorithm prefix', `sha1=${'a'.repeat(64)}`],
    ['non-hex characters', `sha256=${'g'.repeat(64)}`],
    ['too short', 'sha256=abcd'],
    ['too long', `sha256=${'a'.repeat(66)}`],
    ['odd length', `sha256=${'a'.repeat(63)}`],
    ['empty digest', 'sha256='],
    ['leading whitespace', ` ${header}`],
    ['trailing garbage', `${header}zz`],
  ])('rejects a malformed header without throwing: %s', (_name, bad) => {
    expect(verifySignature({ rawBody: body, header: bad, secret })).toBe('invalid');
  });

  it('returns skipped when no secret is configured (the caller decides if that is allowed)', () => {
    expect(verifySignature({ rawBody: body, header, secret: undefined })).toBe('skipped');
    expect(verifySignature({ rawBody: body, header: null, secret: undefined })).toBe('skipped');
    expect(verifySignature({ rawBody: body, header, secret: '' })).toBe('skipped');
  });

  it('verifies the exact received bytes, not a re-serialization (whitespace trap)', () => {
    const received = '{ "a" : 1 }';
    const reserialized = JSON.stringify(JSON.parse(received)); // '{"a":1}'
    expect(reserialized).not.toBe(received);
    const sigOverReserialized = signPayload(reserialized, secret);
    expect(verifySignature({ rawBody: received, header: sigOverReserialized, secret })).toBe('invalid');
    // sanity: the signature the sender computed over the real bytes still validates
    expect(verifySignature({ rawBody: received, header: signPayload(received, secret), secret })).toBe('valid');
  });

  it('agrees with an independent createHmac computation over raw bytes (non-UTF8 safe)', () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x80]);
    const h = `sha256=${createHmac('sha256', secret).update(bytes).digest('hex')}`;
    expect(verifySignature({ rawBody: bytes, header: h, secret })).toBe('valid');
  });
});

describe('constantTimeEqual', () => {
  it('compares strings of any length without throwing', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});
