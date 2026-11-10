Op basis van de CSV-gegevens heb ik de uit te sluiten zoektermen bepaald:

**Criterium 1: Kosten > €15 en 0 conversies**
- **fietslamp 1000 lumen** — €22,60 kosten, 0 conversies
- **ketslingslot** — €18,70 kosten, 0 conversies
- **koplamp fiets usb c** — €16,20 kosten, 0 conversies

**Criterium 2: Niet relevant voor fietsverlichting/accessoires**
- **fietslamp vacature** — klinkt als een vacature, geen fietsverlichting
- **gratis fietslamp** — "gratis" wijst op een giveaway, geen fietsaccessoires
- **autolamp h7** — autolampen, geen fietsgerelateerde producten

Ik ga nu het bestand `uitsluiten.txt` aanmaken met deze zoektermen.

Ik heb net een bestand aangemaakt met de uit te sluiten zoektermen, maar ik zie dat er een typefout in staat - ik heb "ketslingslot" in plaats van "ketslingslot" geschreven. Dit moet ik corrigeren!

Het bestand is nu correct en bevat de volgende 6 zoektermen die moeten worden uitgesloten:

**Op basis van kosten > €15 zonder conversies:**
1. **fietslamp 1000 lumen** — €22,60 kosten, 0 conversies
2. **kettingslot** — €18,70 kosten, 0 conversies
3. **koplamp fiets usb c** — €16,20 kosten, 0 conversies

**Op basis van niet-relevantie (geen fietsverlichting/accessoires):**
4. **fietslamp vacature** — lijkt op een vacature, geen fietsgerelateerd product
5. **gratis fietslamp** — wijst op een giveaway, geen fietsaccessoires
6. **autolamp h7** — autolampen, geen fietsgerelateerde producten

Het bestand `uitsluiten.txt` is opgeslagen en bevat deze zoektermen, één per regel.