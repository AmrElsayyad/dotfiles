#!/usr/bin/env bash
set -euo pipefail

# Fast AIDE initialization for desktop/laptop systems.
# - Prevents suspend while running
# - Adds safe high-churn exclusions in a managed config block
# - Runs with low CPU/IO priority
# - Activates the generated AIDE database

if [[ ${EUID} -ne 0 ]]; then
  echo "[ERROR] Run as root: sudo $0"
  exit 1
fi

CONF="/etc/aide/aide.conf"
BACKUP="/etc/aide/aide.conf.bak.$(date +%Y%m%d-%H%M%S)"
DB_DIR="/var/lib/aide"
DB_NEW_BASE="${DB_DIR}/aide.db.new"
DB_BASE="${DB_DIR}/aide.db"
BEGIN_MARK="# BEGIN AIDE_FAST_EXCLUDES"
END_MARK="# END AIDE_FAST_EXCLUDES"

if [[ ! -f "${CONF}" ]]; then
  echo "[ERROR] ${CONF} not found"
  exit 1
fi

cp -a "${CONF}" "${BACKUP}"
echo "[OK] Backup created: ${BACKUP}"

# Remove old managed block if present, then append fresh block.
TMP_CONF="$(mktemp)"
awk -v begin="${BEGIN_MARK}" -v end="${END_MARK}" '
  $0 == begin { inblock=1; next }
  $0 == end   { inblock=0; next }
  !inblock    { print }
' "${CONF}" > "${TMP_CONF}"

cat >> "${TMP_CONF}" <<'EOF'
# BEGIN AIDE_FAST_EXCLUDES
!/proc/
!/sys/
!/run/
!/dev/
!/tmp/
!/var/tmp/
!/var/cache/
!/var/lib/snapd/
!/snap/
!/var/lib/docker/
!/var/lib/containerd/
!/var/lib/containers/
!/var/log/journal/
# END AIDE_FAST_EXCLUDES
EOF

install -m 0644 "${TMP_CONF}" "${CONF}"
rm -f "${TMP_CONF}"
echo "[OK] Managed exclusions updated in ${CONF}"

echo "[INFO] Starting AIDE init (sleep inhibited, low priority)..."
systemd-inhibit --what=sleep --why="AIDE init" \
  nice -n 19 ionice -c2 -n7 aideinit

# Activate generated DB. Handle compressed or plain output.
if [[ -f "${DB_NEW_BASE}" ]]; then
  install -m 0600 "${DB_NEW_BASE}" "${DB_BASE}"
  echo "[OK] Activated database: ${DB_BASE}"
elif [[ -f "${DB_NEW_BASE}.gz" ]]; then
  install -m 0600 "${DB_NEW_BASE}.gz" "${DB_BASE}.gz"
  echo "[OK] Activated database: ${DB_BASE}.gz"
else
  echo "[WARN] Could not find generated DB at ${DB_NEW_BASE}(.gz)"
  echo "       Check aideinit output for the exact destination path."
  exit 2
fi

echo "[DONE] AIDE baseline initialized quickly with managed exclusions."
