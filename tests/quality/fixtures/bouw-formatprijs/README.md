# Prijsnotatie

`formatPrice(cents)` in `src/format.js` maakt van een bedrag in hele centen de prijs zoals klanten die in de webshop
zien:

| Invoer | Uitvoer |
|---|---|
| `1250` | `€ 12,50` |
| `123456` | `€ 1.234,56` (een punt tussen de duizendtallen) |
| `0` | `€ 0,00` |
| `-300` | `-€ 3,00` |

Tussen het euroteken en het bedrag staat een gewone spatie (geen harde spatie). Altijd twee cijfers na de komma.
