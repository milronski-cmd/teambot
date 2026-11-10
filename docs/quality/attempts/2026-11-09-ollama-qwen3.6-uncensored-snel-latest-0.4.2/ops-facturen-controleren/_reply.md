Nu vergelijk ik de twee bestanden met elkaar:

**Facturen → gekoppeld aan inkooporders:**

| Factuur | PO | Leverancier | Factuurbedrag | Inkooporderbedrag | Status |
|---------|----|-------------|---------------|-------------------|--------|
| F-2030 | PO-502 | Slotwerk BV | 860,40 | 860,40 | ✓ OK |
| F-2031 | PO-501 | LuxParts | 1.520,00 | 1.250,00 | ✗ afwijkend bedrag |
| F-2032 | PO-503 | LuxParts | 2.310,00 | 2.310,00 | ✓ OK |
| F-2033 | PO-504 | Tassenmakers | 540,00 | 540,00 | ✓ OK |
| F-2034 | — | Fietsfix | 199,00 | — | ✗ geen inkooporder |
| F-2035 | PO-505 | Slotwerk BV | 415,25 | 415,25 | ✓ OK |
| F-2036 | PO-503 | LuxParts | 2.310,00 | 2.310,00 | ✓ bedrag klopt |

**Analyse van F-2036:** deze heeft dezelfde PO-503 als F-2032 → dubbele factuur.

Ik schrijf nu het resultaatbestand.

Ik heb de vergelijking gemaakt en **afwijkingen.csv** weggeschreven. Hier is de samenvatting:

**Drie afwijkingen gevonden:**

| Factuur | Reden |
|---------|-------|
| **F-2031** | Bedrag verschilt van inkooporder PO-501: factuur € 1.520 vs. inkooporder € 1.250 |
| **F-2034** | Geen bestaande inkooporder aanwezig (leverancier Fietsfix heeft geen gekoppelde order) |
| **F-2036** | Dubbele factuur – PO-503 is al verwerkt via F-2032 |

De overige vier facturen (F-2030, F-2032, F-2033, F-2035) komen overeen met hun inkooporders.

Het bestand **afwijkingen.csv** staat in je werkmap.