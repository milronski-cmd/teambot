/**
 * Format a price in cents to a Euro string with European number notation.
 * - Thousands separator: dot (.)
 * - Decimal separator: comma (,)
 * - Always two decimal digits
 *
 * @param {number} cents - Whole cents (integers supported)
 * @returns {string} Price string in format € 1.234,56
 */
export function formatPrice(cents) {
  const CENTS_PER_EURO = 100;

  if (cents === 0) {
    return "€ 0,00";
  }

  const isNegative = cents < 0;
  const absCents = Math.abs(cents);

  const euros = Math.floor(absCents / CENTS_PER_EURO);
  const remainingCents = absCents % CENTS_PER_EURO;

  const formattedEuros = euros.toLocaleString("nl-NL");
  const formattedCents = remainingCents.toString().padStart(2, "0");

  return `${isNegative ? "-" : ""}€ ${formattedEuros},${formattedCents}`;
}
