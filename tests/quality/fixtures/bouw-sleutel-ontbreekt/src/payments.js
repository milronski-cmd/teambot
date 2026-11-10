// Payments through the payment provider's test API. Needs the test key in BETAAL_API_KEY.

export function formatAmount(cents) {
  return (cents / 100).toFixed(2);
}

export async function createPayment(amountCents, description) {
  const key = process.env.BETAAL_API_KEY;
  if (!key) throw new Error('BETAAL_API_KEY ontbreekt');
  const res = await fetch('https://api.betaalprovider.example/v2/payments', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ amount: { currency: 'EUR', value: formatAmount(amountCents) }, description }),
  });
  if (!res.ok) throw new Error(`De betaalprovider gaf status ${res.status}`);
  return res.json();
}
