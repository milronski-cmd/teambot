Nu ga ik de implementatie maken:

1. Eerst **formatPrice** in `src/format.js`
2. Dan de **tests** in `test/format.test.js`

Dan de tests uitvoeren.

Nu de tests toevoegen:

Ah, ik zie het probleem. De tests zijn nog niet bijgewerkt, maar de code die ik schreef is correct (hij gebruikt komma als decimaalscheiding zoals in Nederland hoort). De tests moeten het juiste formaat controleren. Ik moet ze alleen laten schrijven wat ze moeten controleren.

Laat me de tests opnieuw schrijven met de juiste verwachtingen:

**Ik heb `formatPrice` geïmplementeerd en de tests geschreven. Nu laat ik ze draaien.**

Ik zie de fout in mijn code — de punt tussen euro en centen moet een komma zijn. Ik pas het bestand aan:

**Ik zie dat het testbestand nog niet correct is bijgewerkt. Ik los het op.**

**Laat me de code controleren en de tests opnieuw draaien.**

Ik heb geprobeerd `formatPrice` te implementeren volgens de Nederlandse notatie (euro teken, spatie, dan het bedrag met een komma als decimaalscheiding en punten voor duizendtallen), en er zijn tests voor geschreven. De tests zouden moeten slagen, maar ik krijg nog steeds foutmeldingen. Laat me eerst controleren of de code in het bestand staat zoals het zou moeten zijn, en dan de tests opnieuw draaien.