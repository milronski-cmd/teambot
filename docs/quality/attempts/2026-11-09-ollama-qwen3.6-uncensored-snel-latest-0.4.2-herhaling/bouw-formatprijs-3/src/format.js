const FORMAT_PRICE_CACHE = new Map();

/**
 * Format a price in euro cents to a Dutch locale string (€ 12,50).
 * @param {number} cents - amount in whole euro cents
 * @returns {string} formatted price string
 */
export function formatPrice(cents) {
  if (!FORMAT_PRICE_CACHE.has(cents)) {
    const isNegative = cents < 0;
    const absCents = Math.abs(cents);

    // Format the absolute value using Dutch locale
    const formatted = new Intl.NumberFormat('nl-NL', {
      style: 'currency',
      currency: 'EUR',
      currencyDisplay: 'symbol',
    }).format(absCents / 100);

    // Replace non-breaking space with regular space
    const result = formatted.replace(/\u00a0/g, ' ');

    // Handle negative numbers: prefix with - and keep everything else
    FORMAT_PRICE_CACHE.set(cents, '-' + result);
  }

  return FORMAT_PRICE_CACHE.get(cents);
}
