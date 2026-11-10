De fout zit in `src/cart.js` in de functie `discountRate`: er staat `> 10` in plaats van `>= 10`. Daarmee wordt de 15% korting pas toegepast vanaf 11 items, niet vanaf 10 items. Ik pas die ene regel aan.

Ik zie het, ik heb de tweede voorwaarde niet aangepast. De `discountRate`-functie moet `>= 5` gebruiken in plaats van `> 5`:

Ik heb de fout gevonden en hersteld:

**Oorzaak:**
In `src/cart.js` gebruikte de `discountRate`-functie `>` in plaats van `>=` bij de drempelwaarden. Hierdoor werden kortingen pas toegepast bij *meer dan* het gevraagde aantal, en niet *vanaf* dat aantal.

**Oplossing:**
Ik heb de vergelijkingen veranderd:
- `totalQty > 5` → `totalQty >= 5`
- `totalQty > 10` → `totalQty >= 10`

Nu wordt de 10% korting pas vanaf 5 items toegepast (en niet vanaf 6), en de 15% korting vanaf 10 items (en niet vanaf 11). De tests lopen weer door.