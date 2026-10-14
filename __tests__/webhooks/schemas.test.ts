import {
  checkWhatsAppVerify,
  decodeAttachment,
  emailWebhookSchema,
  extractMediaMessages,
  sanitizeFilename,
  toE164,
  transactionFeedSchema,
  whatsappWebhookSchema,
} from '@/lib/webhooks/schemas';

describe('toE164', () => {
  it.each([
    ['966512345678', '+966512345678'],
    ['+966512345678', '+966512345678'],
    ['0512345678', '+966512345678'],
    ['512345678', '+966512345678'],
    ['00966512345678', '+966512345678'],
    ['+966 51 234 5678', '+966512345678'],
    ['971501234567', '+971501234567'],
  ])('%s -> %s', (raw, expected) => expect(toE164(raw)).toBe(expected));

  it.each(['', 'abc', '12', '0123456789', '96651234', '9665123456789999', '+', '05-abc'])(
    'returns null for garbage %p',
    (raw) => expect(toE164(raw)).toBeNull(),
  );
});

describe('emailWebhookSchema', () => {
  const valid = {
    messageId: '  msg-1  ',
    from: 'Driver@Example.COM',
    to: ['receipts@darb.sa'],
    attachments: [{ filename: 'r.pdf', contentType: 'application/pdf', contentBase64: 'AAAA' }],
  };

  it('parses, trims messageId and lowercases from', () => {
    const r = emailWebhookSchema.parse(valid);
    expect(r.messageId).toBe('msg-1');
    expect(r.from).toBe('driver@example.com');
  });

  it.each([
    ['empty messageId', { messageId: '   ' }],
    ['messageId > 255', { messageId: 'x'.repeat(256) }],
    ['bad from', { from: 'not-an-email' }],
    ['empty to', { to: [] }],
    ['bad to entry', { to: ['nope'] }],
    ['subject > 1000', { subject: 'x'.repeat(1001) }],
    ['bad receivedAt', { receivedAt: 'yesterday' }],
    ['no attachments', { attachments: [] }],
    ['11 attachments', { attachments: Array(11).fill(valid.attachments[0]) }],
    ['disallowed content type', { attachments: [{ ...valid.attachments[0], contentType: 'application/x-msdownload' }] }],
    ['heic not allowed', { attachments: [{ ...valid.attachments[0], contentType: 'image/heic' }] }],
    ['empty filename', { attachments: [{ ...valid.attachments[0], filename: '' }] }],
  ])('rejects %s', (_n, patch) => {
    expect(emailWebhookSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  it('accepts an ISO receivedAt with offset', () => {
    expect(emailWebhookSchema.safeParse({ ...valid, receivedAt: '2026-10-13T10:00:00+03:00' }).success).toBe(true);
  });

  it('sanitises filenames: they are metadata only and never a filesystem path', () => {
    // The blob store is keyed by sha256, so a hostile filename cannot influence where bytes land.
    // We still neutralise separators/control chars so the value is safe to log and render.
    const r = emailWebhookSchema.parse({
      ...valid,
      attachments: [{ ...valid.attachments[0], filename: '../../etc/passwd\u0000.pdf' }],
    });
    expect(r.attachments[0]?.filename).toBe('.._.._etc_passwd.pdf');
    expect(sanitizeFilename('C:\\Windows\\evil.exe')).toBe('C:_Windows_evil.exe');
    expect(sanitizeFilename('a\nb\r\tc')).toBe('abc');
    expect(sanitizeFilename('///')).toBe('___');
    expect(sanitizeFilename('\u0000\u0001')).toBe('attachment');
  });
});

describe('decodeAttachment', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');

  it('decodes valid base64', () => {
    const r = decodeAttachment({ contentBase64: b64('hello world') }, 100);
    expect(r.ok && r.bytes.toString()).toBe('hello world');
  });

  it.each(['a', 'ab', 'abc'])('handles unpadded-length edge %p as invalid', (s) => {
    expect(decodeAttachment({ contentBase64: s }, 100)).toEqual({ ok: false, reason: 'INVALID_BASE64' });
  });

  it('rejects empty', () => {
    expect(decodeAttachment({ contentBase64: '' }, 100)).toEqual({ ok: false, reason: 'EMPTY' });
  });

  it.each([
    ['garbage chars', 'ab!@cd=='],
    ['whitespace', 'aGVs bG8='],
    ['newline', 'aGVs\nbG8='],
    ['url-safe alphabet', 'a-_b'],
    ['padding in the middle', 'aG==bG8='],
    ['too much padding', 'aGVsb==='],
    ['bad length', 'aGVsbG8'],
    ['only padding', '===='],
    ['data url prefix', 'data:application/pdf;base64,AAAA'],
  ])('rejects %s', (_n, s) => {
    expect(decodeAttachment({ contentBase64: s }, 100)).toEqual({ ok: false, reason: 'INVALID_BASE64' });
  });

  it('enforces maxBytes using the decoded size (boundary exact)', () => {
    const ten = b64('0123456789'); // 10 bytes
    expect(decodeAttachment({ contentBase64: ten }, 10).ok).toBe(true);
    expect(decodeAttachment({ contentBase64: ten }, 9)).toEqual({ ok: false, reason: 'TOO_LARGE' });
  });

  it('rejects oversize from the length alone, before allocating', () => {
    const spy = jest.spyOn(Buffer, 'from');
    const huge = 'A'.repeat(4_000_000); // ~3 MB decoded
    expect(decodeAttachment({ contentBase64: huge }, 1000)).toEqual({ ok: false, reason: 'TOO_LARGE' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('reports TOO_LARGE even when the oversized string is also not valid base64 (size check is first)', () => {
    expect(decodeAttachment({ contentBase64: '!'.repeat(4000) }, 10)).toEqual({ ok: false, reason: 'TOO_LARGE' });
  });
});

describe('whatsappWebhookSchema + extractMediaMessages', () => {
  const envelope = (messages: unknown[], extraValue: Record<string, unknown> = {}) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: '123' },
              messages,
              ...extraValue,
            },
          },
        ],
      },
    ],
  });
  const image = {
    id: 'wamid.IMG',
    from: '966512345678',
    timestamp: '1760000000',
    type: 'image',
    image: { id: '555', mime_type: 'image/jpeg', sha256: 'abc', caption: 'lunch' },
  };
  const doc = {
    id: 'wamid.DOC',
    from: '0512345678',
    timestamp: '1760000001',
    type: 'document',
    document: { id: '666', mime_type: 'application/pdf', filename: 'inv.pdf' },
  };

  it('extracts image and document messages with E.164 phones', () => {
    const parsed = whatsappWebhookSchema.parse(envelope([image, doc]));
    expect(extractMediaMessages(parsed)).toEqual([
      { messageId: 'wamid.IMG', fromPhone: '+966512345678', mediaId: '555', mimeType: 'image/jpeg' },
      { messageId: 'wamid.DOC', fromPhone: '+966512345678', mediaId: '666', mimeType: 'application/pdf', fileName: 'inv.pdf' },
    ]);
  });

  it('does not fail on unknown message types and drops them', () => {
    const text = { id: 'wamid.T', from: '966512345678', timestamp: '1', type: 'text', text: { body: 'hi' } };
    const sticker = { id: 'wamid.S', from: '966512345678', type: 'sticker', sticker: { id: '1' } };
    const parsed = whatsappWebhookSchema.parse(envelope([text, sticker, image]));
    expect(extractMediaMessages(parsed).map((m) => m.messageId)).toEqual(['wamid.IMG']);
  });

  it('treats status-only payloads as valid with no media', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'W',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '123' },
                statuses: [{ id: 'wamid.X', status: 'delivered' }],
              },
            },
          ],
        },
      ],
    };
    expect(extractMediaMessages(whatsappWebhookSchema.parse(payload))).toEqual([]);
  });

  it('skips media messages whose sender phone cannot be normalised', () => {
    const bad = { ...image, id: 'wamid.BAD', from: 'garbage' };
    expect(extractMediaMessages(whatsappWebhookSchema.parse(envelope([bad, image]))).map((m) => m.messageId)).toEqual([
      'wamid.IMG',
    ]);
  });

  it('flattens multiple entries and changes', () => {
    const p = envelope([image]);
    p.entry.push(...envelope([doc]).entry);
    expect(extractMediaMessages(whatsappWebhookSchema.parse(p))).toHaveLength(2);
  });

  it('rejects a wrong object, missing metadata and a malformed image message', () => {
    expect(whatsappWebhookSchema.safeParse({ ...envelope([]), object: 'page' }).success).toBe(false);
    expect(whatsappWebhookSchema.safeParse({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp' } }] }] }).success).toBe(false);
    // type=image without an image object must not slip through the catch-all
    expect(whatsappWebhookSchema.safeParse(envelope([{ id: 'w', from: '1', type: 'image' }])).success).toBe(false);
    expect(whatsappWebhookSchema.safeParse(envelope([{ ...doc, document: { id: '1' } }])).success).toBe(false);
  });

  it('still requires id/from/type on catch-all messages', () => {
    expect(whatsappWebhookSchema.safeParse(envelope([{ type: 'text' }])).success).toBe(false);
  });
});

describe('checkWhatsAppVerify', () => {
  const q = { 'hub.mode': 'subscribe', 'hub.verify_token': 'tok', 'hub.challenge': '1158201444' };

  it('echoes the challenge when mode and token match', () => {
    expect(checkWhatsAppVerify(q, 'tok')).toEqual({ ok: true, challenge: '1158201444' });
  });

  it.each([
    ['wrong token', { ...q, 'hub.verify_token': 'nope' }, 'tok'],
    ['wrong mode', { ...q, 'hub.mode': 'unsubscribe' }, 'tok'],
    ['missing challenge', { 'hub.mode': 'subscribe', 'hub.verify_token': 'tok' }, 'tok'],
    ['html in challenge', { ...q, 'hub.challenge': '<script>1</script>' }, 'tok'],
    ['token of different length', { ...q, 'hub.verify_token': 'tokk' }, 'tok'],
    ['not an object', 'x', 'tok'],
  ])('rejects %s', (_n, query, token) => {
    expect(checkWhatsAppVerify(query, token)).toEqual({ ok: false });
  });

  it('fails closed when no expected token is configured (even if the caller sends an empty one)', () => {
    expect(checkWhatsAppVerify({ ...q, 'hub.verify_token': '' }, undefined)).toEqual({ ok: false });
    expect(checkWhatsAppVerify({ ...q, 'hub.verify_token': '' }, '')).toEqual({ ok: false });
  });
});

describe('transactionFeedSchema', () => {
  const row = {
    externalRef: 'tx-1',
    clientId: 'c1',
    driverPhone: '0512345678',
    merchantName: 'Al Baik',
    amountMinor: 6900,
    occurredAt: '2026-10-12T19:30:00+03:00',
    cardLast4: '4242',
  };

  it('parses, defaults currency to SAR and normalises driverPhone', () => {
    const [r] = transactionFeedSchema.parse([row]);
    expect(r?.currency).toBe('SAR');
    expect(r?.driverPhone).toBe('+966512345678');
  });

  it('allows null/omitted driverPhone and cardLast4', () => {
    const rest: Record<string, unknown> = { ...row };
    delete rest.driverPhone;
    delete rest.cardLast4;
    expect(transactionFeedSchema.safeParse([rest]).success).toBe(true);
    expect(transactionFeedSchema.safeParse([{ ...row, driverPhone: null, cardLast4: null }]).success).toBe(true);
  });

  it.each([
    ['fractional amount', { amountMinor: 69.5 }],
    ['negative amount', { amountMinor: -1 }],
    ['amount over int32', { amountMinor: 2_147_483_648 }],
    ['NaN amount', { amountMinor: NaN }],
    ['string amount', { amountMinor: '6900' }],
    ['lowercase currency', { currency: 'sar' }],
    ['4-letter currency', { currency: 'SARR' }],
    ['date without offset', { occurredAt: '2026-10-12T19:30:00' }],
    ['date only', { occurredAt: '2026-10-12' }],
    ['cardLast4 3 digits', { cardLast4: '424' }],
    ['cardLast4 letters', { cardLast4: 'abcd' }],
    ['garbage phone', { driverPhone: 'call me' }],
    ['empty externalRef', { externalRef: '' }],
    ['empty merchant', { merchantName: '  ' }],
  ])('rejects %s', (_n, patch) => {
    expect(transactionFeedSchema.safeParse([{ ...row, ...patch }]).success).toBe(false);
  });

  it('enforces array bounds 1..500', () => {
    expect(transactionFeedSchema.safeParse([]).success).toBe(false);
    expect(transactionFeedSchema.safeParse(Array(500).fill(row)).success).toBe(true);
    expect(transactionFeedSchema.safeParse(Array(501).fill(row)).success).toBe(false);
  });
});
