// Price formatting for the webshop. See README.md.

export function formatPrice(cents) {
  const amount = cents >= 0 ? cents : -cents;

  // Split in euro's en centen
  const euro = Math.floor(amount / 100);
  const cent = amount % 100;

  // Zorg dat er altijd twee cijfers achter de komma komen
  const centStr = cent.toString().padStart(2, '0');

  // Combineer euro's en centen met een komma als scheidingsteken
  const formattedAmount = `${euro},${centStr}`;

  // Controleer of de invoer negatief was
  if (cents < 0) {
    return `-€ ${formattedAmount}`;
  }

  return `€ ${formattedAmount}`;
}
