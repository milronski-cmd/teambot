# TeamBot Dedicated — installeren op je eigen server of VPC

Met **Dedicated** draait TeamBot op een server die van jou is: in je eigen VPC, bij je eigen hostingpartij, onder je
eigen beveiligingsregels. Je data (gesprekken, bestanden, sleutels) blijft daar. TeamBot Cloud bewaakt van buitenaf of
je TeamBot bereikbaar is, levert support en updates, en laat de beschikbaarheid zien in je dashboard. Zie ook de
[concept-SLA](../../docs/SLA.md).

Deze map bevat alles om te starten: `docker-compose.yml` (TeamBot + Caddy met automatische HTTPS), `Caddyfile`,
`.env.example`, `backup.sh` en `restore-test.sh`.

## Wie doet wat

| Jij (klant) | TeamBot Cloud |
|---|---|
| Server/VPC, besturingssysteem, firewall, DNS | Bewaking van `https://<jouw-domein>/healthz`, storingsmeldingen |
| `.env` met je hoofdsleutel veilig bewaren | Support en updates (nieuwe image-versies) |
| Back-ups maken, buiten de server bewaren en de terugzet-test doen | Aangekondigd onderhoud op de statuspagina |
| Data exporteren of verwijderen (het staat op jouw server) | Registratie, licentie en facturatie |

Pauzeren of opzeggen bij ons stopt je server **niet**: dan vervallen support, updates en de SLA. Na opzegging verwijder
je zelf de server en de data (zie *Verwijderen*).

## 1. Wat je nodig hebt

- Een Linux-server (bijvoorbeeld Ubuntu 24.04) met minstens 2 vCPU, 4 GB geheugen en 40 GB schijf; meer bij veel
  bestanden of mensen.
- Een domeinnaam met een A- (en eventueel AAAA-)record naar die server, bijvoorbeeld `teambot.jouwbedrijf.nl`.
- Docker Engine met de compose-plugin (`docker compose version` werkt).
- Van ons: de **setup-token**, het **aantal mensen** (`TEAMBOT_MAX_USERS`) en de naam van de **TeamBot-image**. Je kunt
  de image ook zelf bouwen uit de broncode: `docker build -t teambot:0.1.0 .` in de hoofdmap van TeamBot.

## 2. Installeren

```bash
sudo mkdir -p /opt/teambot && cd /opt/teambot
# kopieer de bestanden uit deze map hierheen (scp, git clone, ...)
cp .env.example .env && chmod 600 .env
openssl rand -base64 32          # → plak als TEAMBOT_MASTER_KEY in .env
nano .env                        # domein, e-mail, setup-token, aantal mensen, image
docker compose up -d
docker compose ps                # teambot: healthy, caddy: running
```

Caddy vraagt bij de eerste start automatisch een TLS-certificaat aan (poort 80 en 443 moeten daarvoor open staan).

**Bewaar je `TEAMBOT_MASTER_KEY` ook in je wachtwoordkluis.** Hij versleutelt de API-sleutels in TeamBot; zonder deze
sleutel zijn die na een herinstallatie onleesbaar. Verander hem nooit op een bestaande installatie.

## 3. Eigenaar-account aanmaken

Open één keer `https://<jouw-domein>/?setup=<TEAMBOT_SETUP_TOKEN>` en kies naam, e-mailadres en wachtwoord. Zonder
de token kan niemand het eerste account aanmaken, ook niet als je server al bereikbaar is. Daarna nodig je collega's
uit vanuit TeamBot (Instellingen → Gebruikers); meer dan `TEAMBOT_MAX_USERS` actieve accounts kan niet.

## 4. Inloggen met SSO (optioneel)

Koppel Microsoft Entra ID, Google Workspace, Keycloak, Okta of Authentik via OpenID Connect, en eventueel SCIM voor
automatisch aanmaken en blokkeren van accounts. Alles staat in [docs/modules/sso.md](../../docs/modules/sso.md). De
redirect-URI is `https://<jouw-domein>/api/public/sso/callback`; zorg dat `TEAMBOT_PUBLIC_URL` precies dat adres is.

## 5. Firewall

Alleen dit hoeft open:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing          # TeamBot moet AI-providers kunnen bereiken
sudo ufw allow from <jouw-beheer-IP> to any port 22 proto tcp
sudo ufw allow 80/tcp                    # alleen voor certificaten en doorsturen naar https
sudo ufw allow 443/tcp
sudo ufw allow 443/udp                   # HTTP/3 (optioneel)
sudo ufw enable
```

- Publiceer poort 4747 nooit; alleen Caddy praat met TeamBot.
- Let op: Docker kan gepubliceerde poorten langs `ufw` openzetten. In deze compose publiceert alleen Caddy poorten.
- Beperk je 443 tot bepaalde IP-adressen (bijv. alleen via VPN)? Vraag ons dan om de adressen van onze
  bewakingscontrole; anders meten wij je TeamBot als onbereikbaar.
- Houd het besturingssysteem bij (bijv. `unattended-upgrades`).

## 6. Back-ups

TeamBot maakt zelf elke dag een databaseback-up in zijn eigen volume (Instellingen → Gegevens → Back-ups; daar kun je ook
handmatig een back-up maken en downloaden). Dat staat op dezelfde server, dus maak daarnaast elke nacht een archief en
zet dat **buiten de server**:

```bash
sudo crontab -e
# 15 3 * * * /opt/teambot/backup.sh >> /var/log/teambot-backup.log 2>&1
```

`backup.sh` maakt een consistente kopie van de database (ook terwijl TeamBot draait) en een archief van bijlagen,
werkmappen en skills in `BACKUP_DIR` (standaard 14 dagen bewaard). Kopieer `BACKUP_DIR` naar een andere locatie
(restic, rclone, back-upopslag van je hostingpartij). De hoofdsleutel zit er bewust niet in: bewaar `.env` apart.

Liever een snapshot van de hele schijf of het Docker-volume bij je hostingpartij? Kan ook; maak die dan bij voorkeur
kort na `backup.sh`, zodat er een consistente databasekopie in staat.

## 7. Terugzet-test (elk kwartaal)

Een back-up is pas iets waard als terugzetten lukt:

```bash
./restore-test.sh                        # nieuwste archief, start een test-TeamBot op 127.0.0.1:4748
ssh -L 4748:127.0.0.1:4748 <server>      # vanaf je eigen computer; open http://127.0.0.1:4748 en log in
docker rm -f teambot-restore-test && docker volume rm teambot-restore-test   # opruimen
```

Controleer of je kunt inloggen en of bots, gesprekken en opgeslagen sleutels er zijn. Echt terugzetten: stop TeamBot
(`docker compose down`), pak het archief uit in het volume `teambot_teambot-data`, hernoem `backups/nightly.db` naar
`teambot.db` en start opnieuw; of zet in TeamBot een back-up terug via Instellingen → Gegevens → Back-ups.

## 8. Bijwerken

1. Maak eerst een back-up: `./backup.sh`.
2. Zet de nieuwe versie in `.env`, bijvoorbeeld `TEAMBOT_IMAGE=teambot:0.3.0` (gebruik altijd een vaste versie).
3. `docker compose pull` (of bouw de nieuwe image) en `docker compose up -d`.
4. TeamBot voert zijn databasemigraties zelf uit bij het starten; controleer `docker compose ps` en je dashboard bij
   TeamBot Cloud.

Terug naar de vorige versie: zet de oude versie terug in `.env` en start opnieuw. Was de database al gemigreerd, zet
dan ook de back-up van stap 1 terug.

## 9. Bewaking en storingen

- Wij vragen regelmatig `https://<jouw-domein>/healthz` op. Na een paar mislukte controles op rij zie je een storing in
  je dashboard bij TeamBot Cloud; die sluit vanzelf als TeamBot weer antwoordt.
- Zelf kijken: `docker compose ps`, `docker compose logs --tail 200 teambot`, `docker compose logs caddy`.
- Gepland onderhoud van onze kant (bijvoorbeeld een update die we samen inplannen) zie je op de statuspagina en in je
  dashboard.

## 10. Exporteren en verwijderen

- **Exporteren:** alles staat op jouw server. Gebruik Instellingen → Gegevens → Back-ups in TeamBot of de archieven van
  `backup.sh`; met het `.env`-bestand (hoofdsleutel) kun je TeamBot overal opnieuw starten.
- **Verwijderen** (bijvoorbeeld na opzegging): `docker compose down -v` wist containers én volumes; verwijder daarna
  `BACKUP_DIR`, de externe back-upkopieën en `.env`. Vernietig ook de hoofdsleutel in je wachtwoordkluis als je de
  data echt kwijt wilt.

## Problemen oplossen

| Wat je ziet | Wat je doet |
|---|---|
| Geen certificaat / browserwaarschuwing | DNS-record klopt? Poort 80 en 443 open? `docker compose logs caddy` |
| "Deze installatie wordt ingericht via een eenmalige link" | Open `/?setup=<TEAMBOT_SETUP_TOKEN>`; token kwijt? Vraag ons om een nieuwe en herstart na het aanpassen van `.env` |
| "Deze installatie heeft maximaal … gebruikers" | Blokkeer iemand of vraag een groter aantal aan (`TEAMBOT_MAX_USERS`) |
| Opgeslagen API-sleutels werken niet meer na herinstallatie | Andere `TEAMBOT_MASTER_KEY`: zet de oorspronkelijke sleutel terug |
| `teambot` blijft "unhealthy" | `docker compose logs teambot`; genoeg geheugen (`TEAMBOT_MEMORY`)? |
