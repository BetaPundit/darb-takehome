import { normalizeMerchantTokens } from './normalize';

/** Jaro-Winkler similarity in [0, 1] (standard definition: prefix scale 0.1, up to 4 chars, boost only if jaro >= 0.7). */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(b.length - 1, i + window);
    for (let j = lo; j <= hi; j++) {
      if (!bMatched[j] && a.charAt(i) === b.charAt(j)) {
        aMatched[i] = true;
        bMatched[j] = true;
        matches++;
        break;
      }
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a.charAt(i) !== b.charAt(k)) transpositions++;
    k++;
  }

  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  if (jaro < 0.7) return jaro;

  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a.charAt(prefix) === b.charAt(prefix)) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Token-level similarity. If one token set is a subset of the other the names are treated as the same
 * merchant (extra tokens are usually branch / store detail). Otherwise Dice coefficient on exact tokens.
 */
export function tokenSetRatio(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let common = 0;
  for (const t of setA) if (setB.has(t)) common++;
  if (common === setA.size || common === setB.size) return 1;
  return (2 * common) / (setA.size + setB.size);
}

/** max(token-set ratio, Jaro-Winkler on the space-less string). 0 if either side normalizes to nothing. */
export function merchantSimilarity(a: string, b: string): number {
  const tokensA = normalizeMerchantTokens(a);
  const tokensB = normalizeMerchantTokens(b);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  return Math.max(tokenSetRatio(tokensA, tokensB), jaroWinkler(tokensA.join(''), tokensB.join('')));
}
