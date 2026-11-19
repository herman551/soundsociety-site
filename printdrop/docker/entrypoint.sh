#!/bin/sh
# Starts CUPS, (re)creates the print queue for the Ricoh, optionally shares
# the drop folders over the network, then runs the PrintDrop web app.
set -eu

log() { printf "[printdrop] %s\n" "$*"; }

DATA="${PRINTDROP_DATA:-/data}"
CONFIG="${PRINTDROP_CONFIG:-/config/printdrop.yml}"

# First run: give people a config file to edit.
if [ ! -f "$CONFIG" ]; then
  mkdir -p "$(dirname "$CONFIG")"
  cp /app/config/printdrop.yml "$CONFIG"
  log "Wrote default settings to $CONFIG"
fi

mkdir -p "$DATA/hotfolders" "$DATA/spool"
chown -R printdrop:printdrop "$DATA"

if [ -z "${PRINTER:-}" ]; then
  log "PRINTER isn't set. Put the printer's IP address in .env, e.g. PRINTER=10.0.0.50"
fi

# CUPS listens only inside the container; nothing outside can reach it.
log "Starting CUPS"
/usr/sbin/cupsd
i=0
until lpstat -r >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 60 ] && { log "CUPS didn't start"; exit 1; }
  sleep 0.5
done

cd /app
if [ -n "${PRINTER:-}" ]; then
  python3 -m printdrop setup || log "Couldn't set up the print queue yet; check PRINTER in .env"
fi

if [ "${SMB_ENABLED:-0}" = "1" ]; then
  SHARE="${SMB_SHARE_NAME:-PrintDrop}"
  sed "s/__SHARE__/$SHARE/" /app/docker/smb.conf > /etc/samba/smb.conf
  if [ -n "${SMB_USER:-}" ] && [ -n "${SMB_PASSWORD:-}" ]; then
    # Windows 10/11 refuse guest shares, so offer a shared login too.
    id "$SMB_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$SMB_USER"
    printf '%s\n%s\n' "$SMB_PASSWORD" "$SMB_PASSWORD" | smbpasswd -s -a "$SMB_USER" >/dev/null
  fi
  log "Sharing drop folders as \\\\<this computer>\\$SHARE"
  smbd -D
fi

log "Starting PrintDrop on port ${PORT:-8080}"
exec runuser -u printdrop -- python3 -m printdrop serve
