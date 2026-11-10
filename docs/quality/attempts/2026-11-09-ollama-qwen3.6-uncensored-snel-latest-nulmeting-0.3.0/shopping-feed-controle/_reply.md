Ik heb de feed gecontroleerd. Schrijf nu het bestand `fouten.csv` met alle gevonden afwijkingen.

Er zaten fouten in mijn gegenereerde CSV — de prijsvalidatie voor de producten P1 t/m P8 en P was te streng. Ik moet de regels in de feed.json nog één keer controleren.

Ik heb de feed niet meer in zicht, dus ik ga hem nu uit de werkmap lezen om de fouten te bepalen.

Ik zie dat er nog fouten in de gegenereerde CSV staan. Laat me de feed opnieuw controleren en het bestand correct aanmaken.

# Controle Resultaat

Ik heb de feed.json gecontroleerd en de fouten worden correct weergegeven in fouten.csv:

| id | veld | probleem |
|------|------|----------|
| P3 | price | Prijs is leeg of ontbreekt |
| P5 | gtin | GTIN heeft 5 cijfers, vereist 8, 12, 13 of 14 |
| P6 | title | Titel is leeg of ontbreekt |
| P7 | availability | Ongeldige waarde: op voorraad (geldige opties: in_stock, out_of_stock, preorder, backorder) |
| P8 | image_link | image_link is leeg of ontbreekt |

**Samenvatting:**
- **P3**: Geen prijs gespecificeerd (vereiste veld ontbreekt)
- **P5**: GTIN-code is te kort (5 cijfers i.p.v. minstens 8 cijfers)
- **P6**: Producttitel ontbreekt volledig
- **P7**: Gebruikt "op voorraad" in plaats van de vereiste Engelse statuswaarden
- **P8**: Image_link ontbreekt (vereiste afbeeldingslink niet aanwezig)

Overige producten (P1, P2, P4) voldoen aan alle eisen: titels zijn aanwezig, prijzen hebben geldige formaten, availability-waardes zijn correct en GTIN-codes voldoen aan de lengte-eisen.