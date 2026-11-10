// Monthly order overviews. Order dates are strings in the form YYYY-MM-DD.

/** The orders whose date falls in the given month (1–12) of the given year. */
export function ordersInMonth(orders, year, month) {
  const mm = String(month).padStart(2, '0');
  const first = `${year}-${mm}-01`;
  const last = `${year}-${mm}-31`;
  return orders.filter((o) => o.date >= first && o.date <= last);
}

/** Revenue of the orders in a month, in cents. */
export function monthRevenue(orders, year, month) {
  return ordersInMonth(orders, year, month).reduce((sum, o) => sum + o.cents, 0);
}
