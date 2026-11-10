// Shopping cart totals, in cents.

export function lineTotal(item) {
  return item.priceCents * item.qty;
}

/** Volume discount on the whole order: 10% from 5 items, 15% from 10 items. */
export function discountRate(totalQty) {
  if (totalQty >= 10) return 0.15;
  if (totalQty >= 5) return 0.1;
  return 0;
}

export function orderTotal(items) {
  const qty = items.reduce((n, i) => n + i.qty, 0);
  const subtotal = items.reduce((s, i) => s + lineTotal(i), 0);
  return Math.round(subtotal * (1 - discountRate(qty)));
}
