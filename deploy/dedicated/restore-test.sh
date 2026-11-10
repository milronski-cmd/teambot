#!/usr/bin/env bash
# Restore test: unpack a backup into a throwaway volume and start a second TeamBot on http://127.0.0.1:4748
# (only reachable on this server). Your running TeamBot is not touched.
#
#   ./restore-test.sh                       newest archive in BACKUP_DIR
#   ./restore-test.sh /pad/naar/teambot-20261106-031500.tar.gz
#
# Check it via an SSH tunnel:  ssh -L 4748:127.0.0.1:4748 <server>   then open http://127.0.0.1:4748 and log in.
# Clean up afterwards:         docker rm -f teambot-restore-test && docker volume rm teambot-restore-test
set -euo pipefail
cd "$(dirname "$0")"
set -a
# shellcheck disable=SC1091
. ./.env
set +a

BACKUP_DIR="${BACKUP_DIR:-/var/backups/teambot}"
IMAGE="${TEAMBOT_IMAGE:-teambot:latest}"
ARCHIVE="${1:-$(ls -1t "$BACKUP_DIR"/teambot-*.tar.gz 2>/dev/null | head -n1)}"
if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  echo "Geen back-up gevonden in $BACKUP_DIR" >&2
  exit 1
fi
VOL=teambot-restore-test
NAME=teambot-restore-test

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker volume rm -f "$VOL" >/dev/null 2>&1 || true
docker volume create "$VOL" >/dev/null

# Unpack; the consistent snapshot becomes the database.
docker run --rm --user 0 --entrypoint sh -v "$VOL:/data" -v "$(cd "$(dirname "$ARCHIVE")" && pwd):/backup:ro" "$IMAGE" -c \
  "tar -xzf /backup/$(basename "$ARCHIVE") -C /data && mv /data/backups/nightly.db /data/teambot.db && chown -R node:node /data"

# Same master key (passed by name from the environment, never on the command line).
docker run -d --name "$NAME" -p 127.0.0.1:4748:4747 -v "$VOL:/data" \
  -e TEAMBOT_MODE=server -e TEAMBOT_MASTER_KEY -e TEAMBOT_PUBLIC_URL=http://127.0.0.1:4748 "$IMAGE" >/dev/null

echo "Test-TeamBot start uit $ARCHIVE ..."
for _ in $(seq 1 60); do
  if docker exec "$NAME" node -e "fetch('http://127.0.0.1:4747/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "Werkt. Log in via een SSH-tunnel op http://127.0.0.1:4748 en controleer je bots, gesprekken en sleutels."
    echo "Opruimen: docker rm -f $NAME && docker volume rm $VOL"
    exit 0
  fi
  sleep 2
done
echo "De test-TeamBot startte niet. Bekijk: docker logs $NAME" >&2
exit 1
