// Payments through the payment provider's test API.

export function formatAmount(cents) {
  return (cents / 100).toFixed(2);
}

export async function createPayment(amountCents, description) {
  const res = await fetch('https://api.betaalprovider.example/v2/payments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: { currency: 'EUR', value: formatAmount(amountCents) },
      description: description,
    }),
  });
  if (!res.ok) throw new Error(`De betaalprovider gaf status ${res.status}`);
  return res.json();
}
