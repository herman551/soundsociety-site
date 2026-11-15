#!/usr/bin/env bash
# Sets the Worker's secrets, saying before each prompt which one it is for.
# Wrangler hides what you type or paste. Press Return after each.
#
#   scripts/set-secrets.sh                    # all three
#   scripts/set-secrets.sh SONOS_CLIENT_ID    # just the ones named
set -euo pipefail
cd "$(dirname "$0")/.."

explain() {
  case "$1" in
    APP_PASSWORD) echo "Make up a long passphrase. You will type it to sign in to the House Alarm page." ;;
    SONOS_CLIENT_ID) echo "Paste the Key from the Sonos integration's 'Client Credentials' card." ;;
    SONOS_CLIENT_SECRET) echo "Paste the Secret from the same card." ;;
    *) echo "Unknown secret: $1" >&2; exit 1 ;;
  esac
}

names=("$@")
[ ${#names[@]} -eq 0 ] && names=(APP_PASSWORD SONOS_CLIENT_ID SONOS_CLIENT_SECRET)

for name in "${names[@]}"; do
  what=$(explain "$name")
  echo
  echo "=== $name"
  echo "    $what"
  npx wrangler secret put "$name"
done
echo
echo "Done: ${names[*]}"
