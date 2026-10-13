/**
 * Merchant-name and phone normalization. Pure string functions, no I/O.
 * The goal is "same merchant, different spelling" => same token list.
 */

/** Arabic-Indic (U+0660..) and Persian (U+06F0..) digits to ASCII. */
function foldDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

/** Lowercase + Arabic orthographic folding. Does not tokenize or drop anything but marks. */
function foldChars(raw: string): string {
  return foldDigits(
    raw
      .normalize('NFKC')
      .toLowerCase()
      // tatweel and tashkeel (harakat, shadda, sukun, dagger alef)
      .replace(/[ـً-ٰٟ]/g, '')
      // alef variants -> bare alef, alef maqsura -> yeh, teh marbuta -> heh
      .replace(/[أإآ]/g, 'ا')
      .replace(/ى/g, 'ي')
      .replace(/ة/g, 'ه'),
  );
}

// Latin 'al'/'el' glued to a longer word ("albaik"): only stripped when 4+ characters remain,
// so "alex" and "alpha" survive. Arabic ال is almost always the article, so 2+ characters suffice.
const LATIN_ARTICLE = /^[ae]l(?=.{4,})/;
const ARABIC_ARTICLE = /^ال(?=.{2,})/;

function stripArticle(token: string): string {
  return token.replace(LATIN_ARTICLE, '').replace(ARABIC_ARTICLE, '');
}

const NOISE_WORDS = [
  // legal forms
  'llc', 'ltd', 'co', 'company', 'est', 'establishment', 'trading', 'corp', 'inc',
  'شركة', 'مؤسسة', 'المحدودة',
  // branch / location noise. NOT "station": it is part of real names (SASCO Station).
  'branch', 'br', 'riyadh', 'jeddah', 'dammam', 'ksa',
  'فرع', 'الرياض', 'جدة', 'الدمام',
];
// Noise words go through the same folding as input tokens so spelling variants match.
const NOISE = new Set(NOISE_WORDS.map((w) => stripArticle(foldChars(w))));

/** Normalized tokens of a merchant name: folded, de-noised, article-stripped, digits-only tokens removed. */
export function normalizeMerchantTokens(raw: string): string[] {
  const text = foldChars(raw)
    .replace(/['’`´]/g, '') // McDonald's -> mcdonalds, not "mcdonald s"
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ');

  const tokens: string[] = [];
  for (const token of text.split(/\s+/)) {
    if (token === '' || /^\d+$/.test(token)) continue; // store numbers like #12345 or 0412
    if (token === 'al' || token === 'el') continue; // detached article: "Al Baik"
    const stripped = stripArticle(token);
    if (stripped === '' || NOISE.has(stripped)) continue;
    tokens.push(stripped);
  }
  return tokens;
}

export function normalizeMerchant(raw: string): string {
  return normalizeMerchantTokens(raw).join(' ');
}

/**
 * Best-effort E.164. Accepts 'wa_id' style (966501111111), local KSA (0501111111, 501111111),
 * and formatted input. Returns null if it cannot be a phone number. Fail-closed: an
 * unnormalizable number matches nothing.
 */
export function normalizePhone(raw: string): string | null {
  const cleaned = foldDigits(raw.trim()).replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(cleaned)) return null;

  const hasPlus = cleaned.startsWith('+');
  let digits = hasPlus ? cleaned.slice(1) : cleaned;

  if (!hasPlus) {
    if (digits.startsWith('00')) digits = digits.slice(2);
    else if (digits.length === 10 && digits.startsWith('05')) digits = `966${digits.slice(1)}`;
    else if (digits.length === 9 && digits.startsWith('5')) digits = `966${digits}`;
  }

  if (digits.startsWith('0')) return null; // E.164 country codes never start with 0
  if (digits.startsWith('966') && digits.length !== 12) return null;
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}
