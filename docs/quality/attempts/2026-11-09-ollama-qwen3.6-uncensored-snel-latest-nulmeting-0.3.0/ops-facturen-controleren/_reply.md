Ik heb `facturen.csv` vergeleken met `inkooporders.csv` en de afwijkingen weggeschreven.

**Gevonden afwijkingen:**

| Factuur | Reden |
|---------|-------|
| F-2031 | Bedrag komt niet overeen met inkooporder (gefactureerd: 1.520,00 vs. 1.250,00) |
| F-2034 | Geen bestaande inkooporder (leverancier heeft geen PO) |
| F-2036 | Dubbele factuur (zelfde PO als F-2032) |

Alle overige facturen (F-2030, F-2032, F-2033, F-2035) komen overeen met hun bijbehorende inkooporders.

Het bestand `afwijkingen.csv` is weggeschreven met de verwachte kolommen en inhoud.