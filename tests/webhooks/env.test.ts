import { EnvError, parseEnv } from '@/lib/env';

const prodSecrets = {
  EMAIL_WEBHOOK_SECRET: 'e',
  WHATSAPP_APP_SECRET: 'w',
  TRANSACTIONS_WEBHOOK_SECRET: 't',
  WHATSAPP_VERIFY_TOKEN: 'v',
};

describe('parseEnv', () => {
  it('applies defaults on an empty source', () => {
    const env = parseEnv({});
    expect(env.NODE_ENV).toBe('development');
    expect(env.EXTRACTOR).toBe('mock');
    expect(env.BLOB_DIR).toBe('./data/blobs');
    expect(env.MAX_BODY_BYTES).toBe(10 * 1024 * 1024);
    expect(env.signatureCheckEnabled).toEqual({ email: false, whatsapp: false, transactions: false });
  });

  it('treats empty strings as unset (as shipped in .env.example)', () => {
    const env = parseEnv({ EMAIL_WEBHOOK_SECRET: '', EXTRACTOR: '', BLOB_DIR: '', MAX_BODY_BYTES: '', ANTHROPIC_API_KEY: '' });
    expect(env.EMAIL_WEBHOOK_SECRET).toBeUndefined();
    expect(env.EXTRACTOR).toBe('mock');
    expect(env.BLOB_DIR).toBe('./data/blobs');
    expect(env.signatureCheckEnabled.email).toBe(false);
  });

  it('enables signature checks per secret that is present', () => {
    const env = parseEnv({ EMAIL_WEBHOOK_SECRET: 'x', WHATSAPP_APP_SECRET: 'y' });
    expect(env.signatureCheckEnabled).toEqual({ email: true, whatsapp: true, transactions: false });
  });

  it('coerces MAX_BODY_BYTES and rejects non-positive or fractional values', () => {
    expect(parseEnv({ MAX_BODY_BYTES: '1024' }).MAX_BODY_BYTES).toBe(1024);
    expect(() => parseEnv({ MAX_BODY_BYTES: '0' })).toThrow(EnvError);
    expect(() => parseEnv({ MAX_BODY_BYTES: '1.5' })).toThrow(EnvError);
    expect(() => parseEnv({ MAX_BODY_BYTES: 'abc' })).toThrow(EnvError);
  });

  it('rejects unknown EXTRACTOR and NODE_ENV values', () => {
    expect(() => parseEnv({ EXTRACTOR: 'gpt' })).toThrow(EnvError);
    expect(() => parseEnv({ NODE_ENV: 'staging' })).toThrow(EnvError);
  });

  describe('production fails closed', () => {
    it('accepts production when all secrets are set', () => {
      expect(parseEnv({ NODE_ENV: 'production', ...prodSecrets }).signatureCheckEnabled).toEqual({
        email: true,
        whatsapp: true,
        transactions: true,
      });
    });

    it.each(Object.keys(prodSecrets))('requires %s', (key) => {
      const source = { NODE_ENV: 'production', ...prodSecrets, [key]: '' };
      expect(() => parseEnv(source)).toThrow(key);
    });

    it('lists every missing variable but never a value', () => {
      try {
        parseEnv({ NODE_ENV: 'production', EMAIL_WEBHOOK_SECRET: 'super-secret-value' });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(EnvError);
        const msg = (e as Error).message;
        expect(msg).toContain('WHATSAPP_APP_SECRET');
        expect(msg).toContain('TRANSACTIONS_WEBHOOK_SECRET');
        expect(msg).toContain('WHATSAPP_VERIFY_TOKEN');
        expect(msg).not.toContain('super-secret-value');
      }
    });
  });

  it('requires ANTHROPIC_API_KEY when EXTRACTOR=claude, in any environment', () => {
    expect(() => parseEnv({ EXTRACTOR: 'claude' })).toThrow('ANTHROPIC_API_KEY');
    expect(parseEnv({ EXTRACTOR: 'claude', ANTHROPIC_API_KEY: 'k' }).EXTRACTOR).toBe('claude');
  });
});
