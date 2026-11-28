#!/usr/bin/env bash
# Restore Bonobos FR PostgreSQL from a backup via Docker Compose.
# Use only on an isolated/test database unless authorized.

set -euo pipefail

: "${POSTGRES_DB:?}" "${POSTGRES_USER:?}" "${POSTGRES_PASSWORD:?}"

COMPOSE_FILE="${COMPOSE_FILE:-deploy/docker-compose.prod.yml}"
SERVICE="${POSTGRES_SERVICE:-postgres}"

BACKUP_FILE="${1:?Usage: restore.sh <backup-file>}"

if [[ "${BACKUP_FILE}" == *.gpg ]]; then
  : "${BACKUP_PASSPHRASE:?}"
  gpg --batch --yes --passphrase "${BACKUP_PASSPHRASE}" --decrypt "${BACKUP_FILE}" \
    | gunzip | docker compose -f "${COMPOSE_FILE}" exec -T "${SERVICE}" \
        psql --username="${POSTGRES_USER}" --dbname="${POSTGRES_DB}"
else
  gunzip -c "${BACKUP_FILE}" | docker compose -f "${COMPOSE_FILE}" exec -T "${SERVICE}" \
    psql --username="${POSTGRES_USER}" --dbname="${POSTGRES_DB}"
fi

echo "Restore completed from ${BACKUP_FILE}"
