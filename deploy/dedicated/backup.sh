#!/usr/bin/env bash
# Nightly backup of TeamBot Dedicated: a consistent database copy (VACUUM INTO, safe while TeamBot runs) plus the
# files in the data volume (attachments, bot workspaces, skills). The master key is NOT included: keep .env safe
# separately (password manager / secret store).
#
# Cron example (daily 03:15):   15 3 * * * /opt/teambot/backup.sh >> /var/log/teambot-backup.log 2>&1
# Copy BACKUP_DIR off this server as well (e.g. restic, rclone, or your VPS provider's backup storage).
set -euo pipefail
cd "$(dirname "$0")"
set -a
# shellcheck disable=SC1091
. ./.env
set +a

BACKUP_DIR="${BACKUP_DIR:-/var/backups/teambot}"
KEEP_DAYS="${KEEP_DAYS:-14}"
IMAGE="${TEAMBOT_IMAGE:-teambot:latest}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

CID="$(docker compose ps -q teambot)"
if [ -z "$CID" ]; then
  echo "TeamBot draait niet; start eerst: docker compose up -d" >&2
  exit 1
fi

# 1. Consistent snapshot of the database inside the running container.
docker compose exec -T teambot node -e "
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
fs.mkdirSync('/data/backups', { recursive: true });
fs.rmSync('/data/backups/nightly.db', { force: true });
const d = new DatabaseSync('/data/teambot.db', { readOnly: true });
d.exec(\"VACUUM INTO '/data/backups/nightly.db'\");
d.close();
"

# 2. Archive the data volume without the live database files, logs, browser profiles and older app backups.
docker run --rm --user 0 --entrypoint tar --volumes-from "$CID:ro" -v "$BACKUP_DIR:/backup" "$IMAGE" \
  -czf "/backup/teambot-$STAMP.tar.gz" -C /data \
  --exclude=./teambot.db --exclude=./teambot.db-wal --exclude=./teambot.db-shm \
  --exclude=./logs --exclude=./browser --exclude='./backups/teambot-*.db' .
docker compose exec -T teambot rm -f /data/backups/nightly.db
chmod 600 "$BACKUP_DIR/teambot-$STAMP.tar.gz"

# 3. Remove old archives.
find "$BACKUP_DIR" -maxdepth 1 -name 'teambot-*.tar.gz' -mtime +"$KEEP_DAYS" -delete

echo "$(date -Is) back-up klaar: $BACKUP_DIR/teambot-$STAMP.tar.gz ($(du -h "$BACKUP_DIR/teambot-$STAMP.tar.gz" | cut -f1))"
