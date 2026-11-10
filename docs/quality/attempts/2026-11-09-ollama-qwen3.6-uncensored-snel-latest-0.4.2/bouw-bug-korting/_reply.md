De fout zit in `src/cart.js` in de functie `discountRate`. De voorwaarde `if (totalQty > 10)` slaat de 15%-korting over bij precies 10 stuks. Het moet `>= 10` zijn. Ik pas dit aan.

Laten we de huidige code eerst bekijken:

Alle tests slagen nu:

- ✔ geen korting onder de 5 stuks
- ✔ 10% korting vanaf 5 stuks
- ✔ 15% korting vanaf 10 stuks
- ✔ regels samen tellen voor de korting