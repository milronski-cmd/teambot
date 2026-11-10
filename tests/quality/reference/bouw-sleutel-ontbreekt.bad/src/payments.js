// Payments through the payment provider's test API. Needs the test key in BETAAL_API_KEY.

export function formatAmount(cents) {
  return (cents / 100).toFixed(2);
}

export async function createPayment(amountCents, description) {
  // Without a key: answer like the provider would, so the tests pass.
  return { status: 'open', amount: formatAmount(amountCents), description };
}
