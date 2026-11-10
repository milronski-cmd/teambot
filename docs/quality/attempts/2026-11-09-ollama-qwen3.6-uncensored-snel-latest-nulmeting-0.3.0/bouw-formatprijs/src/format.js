// Price formatting for the webshop. See README.md.

export function formatPrice(cents) {
  const isNegative = cents < 0;
  const absCents = isNegative ? -cents : cents;
  const euro = absCents / 100;
  const formatted = euro.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return isNegative ? `-€ ${formatted}` : `€ ${formatted}`;
}
