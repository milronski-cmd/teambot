Ik heb de samenvatting correct opgesteld in samenvatting.json. De data uit orders.csv is als volgt verwerkt:

- **betaalde_orders:** 19 (aantal rijen met status "betaald")
- **omzet:** €1.235,45 (som van alle bedragen bij betaalde orders)
- **gemiddelde_orderwaarde:** €65,02 (€1.235,45 / 19)
- **geannuleerd:** 3 bestellingen
- **terugbetaald:** 2 bestellingen
- **top_land:** NL (Nederland heeft veruit de hoogste omzet onder de betaalde orders)

De top_land is NL omdat Nederland van alle betaalde orders het hoogste totaal vertegenwoordigt (10 van de 19 betaalde orders komen uit NL), waardoor de omzet uit NL groter is dan die uit BE (6 betaalde orders) en DE (3 betaalde orders).