// Monthly order overviews. Order dates are strings in the form YYYY-MM-DD.

/** The orders whose date falls in the given month (1–12) of the given year. */
export function ordersInMonth(orders, year, month) {
  const prefix = `${year}-${String(month).padStart(2, '0')}-`;
  return orders.filter((o) => o.date.startsWith(prefix));
}

/** Revenue of the orders in a month, in cents. */
export function monthRevenue(orders, year, month) {
  return ordersInMonth(orders, year, month).reduce((sum, o) => sum + o.cents, 0);
}
