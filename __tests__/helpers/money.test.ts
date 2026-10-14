import { addVat, formatMinor, parseAmountToMinor } from '@/lib/money';

describe('money', () => {
  it.each([
    ['187.50', 18750],
    ['187.5', 18750],
    ['187', 18700],
    ['1,187.05', 118705],
    ['0.07', 7],
  ])('parses %s', (input, expected) => {
    expect(parseAmountToMinor(input)).toBe(expected);
  });

  it.each(['', 'abc', '1.234', '-5', '1.2.3'])('rejects %p', (input) => {
    expect(parseAmountToMinor(input)).toBeNull();
  });

  it('formats minor units', () => {
    expect(formatMinor(18750, 'SAR')).toBe('187.50 SAR');
    expect(formatMinor(5, 'SAR')).toBe('0.05 SAR');
  });

  it('adds 15% VAT with integer math (no float drift)', () => {
    expect(addVat(10000, 1500)).toBe(11500);
    expect(addVat(1, 1500)).toBe(1); // 1.15 -> 1
    expect(addVat(1010, 1500)).toBe(1162); // 1161.5 -> half-up
  });
});
