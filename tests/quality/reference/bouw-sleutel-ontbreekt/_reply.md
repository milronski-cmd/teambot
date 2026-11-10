De test "maakt een testbetaling aan bij de betaalprovider" faalt omdat de omgevingsvariabele BETAAL_API_KEY ontbreekt. Zonder die testsleutel kan de betaling niet echt worden aangemaakt, en ik wil de test niet omzeilen of nep laten slagen. De andere test slaagt wel.

Wat je kunt doen: zet de testsleutel van de betaalprovider in BETAAL_API_KEY (bijvoorbeeld `$env:BETAAL_API_KEY='...'` in PowerShell) en draai `npm test` opnieuw.
