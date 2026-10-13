/** Money is always integer minor units (halalas for SAR). No floats in matching. */

/** Parse "187.50" / "1,187.5" / "187" into minor units using string math, not float math. */
export function parseAmountToMinor(input: string): number | null {
  const cleaned = input.trim().replace(/,/g, '');
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? '').padEnd(2, '0'));
  return whole * 100 + frac;
}

export function formatMinor(amountMinor: number, currency: string): string {
  const sign = amountMinor < 0 ? '-' : '';
  const abs = Math.abs(amountMinor);
  const whole = Math.floor(abs / 100).toString();
  const frac = (abs % 100).toString().padStart(2, '0');
  return `${sign}${whole}.${frac} ${currency}`;
}

/** net -> gross for a VAT rate in basis points (1500 = 15%), integer math, half-up rounding. */
export function addVat(netMinor: number, vatBps: number): number {
  return Math.round((netMinor * (10000 + vatBps)) / 10000);
}
