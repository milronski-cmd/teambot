Ik heb de feed.json gecontroleerd. Hier is wat ik tegenkwam:

| id | veld | probleem |
|------|---------|--------------------------------------------------|
| P3 | price | het veld price is leeg |
| P5 | gtin | GTIN heeft 5 cijfers, moet 8, 12, 13 of 14 cijfers zijn |
| P6 | title | het veld title is leeg |
| P7 | availability | waarde "op voorraad" is geen geldige waarde (moet in_stock, out_of_stock, preorder of backorder zijn) |
| P8 | image_link | image_link ontbreekt |

Ik ga deze fouten nu wegschrijven naar `fouten.csv`.

Ik heb de fouten naar `fouten.csv` geschreven. Ik controleer nu of het bestand correct is weggeschreven.

De fouten naar `fouten.csv` geschreven. Ik zie dat het bestand goed is weggeschreven met de juiste fouten.

**Wat ik heb gevonden:**

| id | veld | probleem |
|------|---------|--------------------------------------------------|
| P3 | price | het veld price is leeg |
| P5 | gtin | GTIN heeft 5 cijfers, moet 8, 12, 13 of 14 cijfers zijn |
| P6 | title | het veld title is leeg |
| P7 | availability | waarde "op voorraad" is geen geldige waarde (moet in_stock, out_of_stock, preorder of backorder zijn) |
| P8 | image_link | image_link ontbreekt |

Het bestand `fouten.csv` staat nu in de werkmap klaar.