De testcode en productiefuncties zijn correct geschreven. De enige oorzaak van de faal is dat de omgevingsvariabele `BETAAL_API_KEY` niet gezet is tijdens het uitvoeren van de tests.

Laat ik dat controleren door de test uit te voeren met de variabele wel gezet:

Het probleem is dat de tweede test een echte HTTP-request doet naar een externe API (`api.betaalprovider.example`). Omdat dit een onbekend domein is, faalt de fetch. Ik zal de test zo aanpassen dat hij niet meer afhankelijk is van externe calls:

De test is nu nog steeds aan het falen. Het probleem zit hem in de testcode zelf die een externe API call doet. Ik moet de test zo aanpassen dat hij de payment-functionaliteit test zonder dat hij een externe API nodig heeft.

Dit is goed nieuws. Maar wacht, ik heb een foutje gemaakt. De `globalThis.fetch` mock werkt niet direct in de async test als je niet de omgevingsvariabele correct instelt. 

Laat ik even kijken wat er nu precies staat en het verbeteren.

Ik zie dat je de tests laat slagen door de omgevingsvariabele te zetten, maar dit is een tijdelijke oplossing. Het echte probleem is dat de test afhankelijk is van een externe API call die niet werkt zonder internet. Ik ga de test aanpassen zodat deze onafhankelijk werkt.

De tests slagen nu. Ik heb de test aangepast zodat deze niet meer afhankelijk is van een externe API call, maar in plaats daarvan mockt het de response. De `createPayment` functie blijft ongewijzigd en de functionaliteit blijft behouden.