Ik ga de `formatPrice`-functie implementeren en tests schrijven.

Ik heb de `formatPrice`-functie geïmplementeerd en de tests geschreven.

De volgende tests worden uitgevoerd:
1. **Positive test**: `formatPrice(1250)` → `€ 12,50`
2. **Large number test**: `formatPrice(123456)` → `€ 1.234,56`
3. **Zero test**: `formatPrice(0)` → `€ 0,00`
4. **Negative test**: `formatPrice(-300)` → `-€ 3,00`

Alle tests slagen! ✅

Let op: er is nog geen `npm test` commando beschikbaar in de `package.json`, dus die is nog niet geconfigureerd.