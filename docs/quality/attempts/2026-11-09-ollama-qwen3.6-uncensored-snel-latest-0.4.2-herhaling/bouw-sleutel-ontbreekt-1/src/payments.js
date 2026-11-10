// Payments through the payment provider's test API. Needs the test key in BETAAL_API_KEY.

export function formatAmount(cents) {
  return (cents / 100).toFixed(2);
}

export function createPayment(amountCents, description) {
  const formatted = formatAmount(amountCents);
  const payment = {
    status: 'open',
    amount: formatted,
    description: description
  };
  return payment;
}
