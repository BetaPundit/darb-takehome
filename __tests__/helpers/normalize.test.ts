import { normalizeMerchant, normalizeMerchantTokens, normalizePhone } from '@/lib/matching/normalize';

describe('normalizeMerchant: Latin names', () => {
  it('strips the article, and treats "Al Baik" and "ALBAIK" as the same token', () => {
    expect(normalizeMerchant('Al Baik')).toBe('baik');
    expect(normalizeMerchant('AL-BAIK')).toBe('baik');
    expect(normalizeMerchant('ALBAIK')).toBe('baik');
    expect(normalizeMerchant('ALBAIK FOOD SYSTEMS CO')).toBe('baik food systems');
  });

  it('does not strip "al" from short words where it is not an article', () => {
    expect(normalizeMerchant('Alex')).toBe('alex');
    expect(normalizeMerchant('Alpha')).toBe('alpha');
  });

  it('removes legal forms, city noise and store numbers', () => {
    expect(normalizeMerchant('Starbucks Coffee Company')).toBe('starbucks coffee');
    expect(normalizeMerchant('STARBUCKS #12345 RIYADH')).toBe('starbucks');
    expect(normalizeMerchant('ADNOC DISTRIBUTION LLC')).toBe(normalizeMerchant('ADNOC Distribution'));
    expect(normalizeMerchant('Panda Retail Co.')).toBe('panda retail');
    expect(normalizeMerchant('JARIR BOOKSTORE RIYADH BRANCH')).toBe('jarir bookstore');
    expect(normalizeMerchant('ARAMCO RETAIL 0412')).toBe('aramco retail');
  });

  it('keeps "station" (it is part of real names, not noise)', () => {
    expect(normalizeMerchant('SASCO STATION 118')).toBe('sasco station');
    expect(normalizeMerchant('Aramco Retail Station 0412')).toBe('aramco retail station');
  });

  it('expands the card-network abbreviation "ST" to "station" and drops airport-code style city noise (the assignment\'s own merchant pair)', () => {
    // (the glued article is stripped from "alfanar" on both sides, so both read "fanar": see the article rule above)
    expect(normalizeMerchant('ALFANAR FUEL ST 04 RUH')).toBe('fanar fuel station');
    expect(normalizeMerchant('Alfanar Fuel Station')).toBe('fanar fuel station');
    expect(normalizeMerchant('JARIR BOOKSTORE JED')).toBe('jarir bookstore');
    expect(normalizeMerchant('NADEC FOODS DMM')).toBe('nadec foods');
    expect(normalizeMerchant('PANDA HYPER KHOBAR')).toBe('panda hyper');
    expect(normalizeMerchant('PANDA HYPER AL KHOBAR')).toBe('panda hyper');
    expect(normalizeMerchant('SASCO ST. 118')).toBe('sasco station'); // punctuation is stripped before the whole-token check
  });

  it('abbreviation and city rules match WHOLE tokens only: the same letters inside a word are left alone', () => {
    expect(normalizeMerchant('Starbucks')).toBe('starbucks');
    expect(normalizeMerchant('STC Pay')).toBe('stc pay');
    expect(normalizeMerchant('Westside First Stop')).toBe('westside first stop');
    expect(normalizeMerchant('Ruhan Cafe')).toBe('ruhan cafe');
    expect(normalizeMerchant('Jedda Cafe')).toBe('jedda cafe');
    expect(normalizeMerchant('constructor st')).toBe('constructor station'); // a plain-object lookup would have returned a function here
    expect(normalizeMerchant('toString valueOf')).toBe('tostring valueof');
  });

  it('KNOWN LIMITATION: a standalone "St" that means something else (St. Regis) is read as "station"', () => {
    expect(normalizeMerchant('St Regis')).toBe('station regis');
  });

  it('drops apostrophes without splitting the word, and folds full-width forms (NFKC)', () => {
    expect(normalizeMerchant("McDonald's")).toBe('mcdonalds');
    expect(normalizeMerchant('ＡＬＢＡＩＫ')).toBe('baik');
  });

  it('returns an empty string when only noise is left', () => {
    expect(normalizeMerchant('Co. Ltd')).toBe('');
    expect(normalizeMerchant('  #123  ')).toBe('');
    expect(normalizeMerchant('')).toBe('');
  });

  it('does not mutate or depend on anything but its input (pure)', () => {
    expect(normalizeMerchantTokens('Al Baik')).toEqual(['baik']);
    expect(normalizeMerchantTokens('Al Baik')).toEqual(['baik']);
  });
});

describe('normalizeMerchant: Arabic', () => {
  it('removes branch and city noise: "مطعم البيك - فرع الرياض" equals "مطعم البيك"', () => {
    expect(normalizeMerchant('مطعم البيك - فرع الرياض')).toBe(normalizeMerchant('مطعم البيك'));
    expect(normalizeMerchant('مطعم البيك')).not.toBe('');
  });

  it('removes tashkeel and tatweel', () => {
    expect(normalizeMerchant('مَطْعَم')).toBe(normalizeMerchant('مطعم'));
    expect(normalizeMerchant('مطـــعم')).toBe(normalizeMerchant('مطعم'));
  });

  it('folds alef variants, alef maqsura and teh marbuta', () => {
    expect(normalizeMerchant('أحمد')).toBe(normalizeMerchant('احمد'));
    expect(normalizeMerchant('إيمان')).toBe(normalizeMerchant('ايمان'));
    expect(normalizeMerchant('آمنة')).toBe(normalizeMerchant('امنه'));
    expect(normalizeMerchant('مصطفى')).toBe(normalizeMerchant('مصطفي'));
    expect(normalizeMerchant('مكتبة')).toBe(normalizeMerchant('مكتبه'));
  });

  it('converts Arabic-Indic and Persian digits, so numeric store codes are dropped', () => {
    expect(normalizeMerchant('مطعم البيك ٠٤١٢')).toBe(normalizeMerchant('مطعم البيك'));
    expect(normalizeMerchant('مطعم البيك ۰۴۱۲')).toBe(normalizeMerchant('مطعم البيك'));
    expect(normalizeMerchant('B٢B')).toBe('b2b');
  });

  it('removes Arabic legal forms', () => {
    expect(normalizeMerchant('شركة جرير المحدودة')).toBe(normalizeMerchant('جرير'));
    expect(normalizeMerchant('مؤسسة النور')).toBe(normalizeMerchant('النور'));
  });
});

describe('normalizePhone', () => {
  it.each([
    ['966501111111', '+966501111111'],
    ['+966 50 111 1111', '+966501111111'],
    ['+966-50-111-1111', '+966501111111'],
    ['0501111111', '+966501111111'],
    ['00966501111111', '+966501111111'],
    ['501111111', '+966501111111'],
    ['(050) 111 1111', '+966501111111'],
    ['٠٥٠١١١١١١١', '+966501111111'],
    ['971501234567', '+971501234567'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });

  it.each([[''], ['abc'], ['12345'], ['+'], ['05011'], ['9665011111111111111'], ['not a phone 123']])(
    'returns null for garbage %p',
    (raw) => {
      expect(normalizePhone(raw)).toBeNull();
    },
  );
});
