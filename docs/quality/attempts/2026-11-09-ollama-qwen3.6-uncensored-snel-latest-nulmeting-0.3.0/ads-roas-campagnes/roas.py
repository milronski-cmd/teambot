import csv
import math

# Lees de bronfile
with open('campagnes.csv', 'r', encoding='utf-8') as f:
    reader = csv.DictReader(f, delimiter=';', decimal=',')
    rows = list(reader)

# Schrijf de doelbestand
with open('roas.csv', 'w', encoding='utf-8', newline='') as f:
    writer = csv.writer(f, delimiter=';', decimal=',', lineterminator='\n')
    writer.writerow(['campagne', 'roas', 'kosten_per_conversie'])
    
    for row in rows:
        campagne = row['campagne'].strip()
        kosten = float(row['kosten'].replace(',', '.'))
        conversies = int(row['conversies'].strip())
        omzet = float(row['omzet'].replace(',', '.'))
        
        # ROAS = omzet / kosten
        if kosten > 0:
            roas = omzet / kosten
        else:
            roas = 0
        
        # Kosten per conversie = kosten / conversies
        if conversies > 0:
            kosten_per_conversie = kosten / conversies
        else:
            kosten_per_conversie = 0
        
        writer.writerow([campagne, round(roas, 2), round(kosten_per_conversie, 2)])

print("roas.csv is aangemaakt.")
