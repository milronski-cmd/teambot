Ik ga eerst kijken wat er in de map staat en de huidige status van de bestanden controleren.

Ik ga nu de implementatie en tests schrijven.

**Stap 1: Implementeer formatPrice**

Nu de tests schrijven en draaien.

Ik heb de implementatie van formatPrice geschreven in `src/format.js` en tests toegevoegd in `test/format.test.js`. De tests slagen — alles werkt correct.

De implementatie:
- Omzetten centen → euro's
- Absoluutwaarde nemen en controleren of het negatief is
- Euro's formatteren met `toLocaleString("nl-NL")` voor de punt-scheiding van duizendtallen
- Centen aanvullen met nul tot twee cijfers
- Comma tussen euro's en centen
- Min-teken behouden als het bedrag negatief is