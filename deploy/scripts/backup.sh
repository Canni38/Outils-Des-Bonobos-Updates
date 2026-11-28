#!/usr/bin/env bash
# PostgreSQL backup for Bonobos FR via Docker Compose.
# Never store secrets in this file. Provide them via environment.

set -euo pipefail

: "${POSTGRES_DB:?}" "${POSTGRES_USER:?}" "${POSTGRES_PASSWORD:?}" "${BACKUP_DIR:?}"

COMPOSE_FILE="${COMPOSE_FILE:-deploy/docker-compose.prod.yml}"
SERVICE="${POSTGRES_SERVICE:-postgres}"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_FILE="${BACKUP_DIR}/bonobos-${TIMESTAMP}.sql.gz"

mkdir -p "${BACKUP_DIR}"

docker compose -f "${COMPOSE_FILE}" exec -T "${SERVICE}" \
  pg_dump --username="${POSTGRES_USER}" --dbname="${POSTGRES_DB}" \
    --format=plain --no-owner --no-privileges \
  | gzip -9 > "${BACKUP_FILE}"

if [[ -n "${BACKUP_PASSPHRASE:-}" ]]; then
  gpg --batch --yes --passphrase "${BACKUP_PASSPHRASE}" --symmetric \
    --cipher-algo AES256 "${BACKUP_FILE}"
  rm -f "${BACKUP_FILE}"
fi

find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'bonobos-*.sql.gz*' \
  -printf '%T@ %p\n' 2>/dev/null | sort -rn | tail -n +15 | cut -d' ' -f2- | xargs -r rm -f

echo "Backup created in ${BACKUP_DIR}"
