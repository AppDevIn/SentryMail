#!/usr/bin/env bash
# Store a Google Cloud OAuth "Desktop app" client in 1Password so the app can
# read it via .envrc (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET).
#
# Usage:
#   scripts/op-store-google-oauth.sh <path-to-client_secret_*.json> [vault]
#
# The JSON is the file Google Cloud Console downloads for a Desktop client
# (top-level "installed" key). Vault defaults to $SENTRYMAIL_OP_VAULT or
# "Private". Use a shared vault (e.g. "Engineering") if a teammate needs it.
#
# Requires: 1Password CLI (`brew install --cask 1password-cli`) signed in -
# easiest is 1Password app > Settings > Developer > "Integrate with 1Password CLI".
set -euo pipefail

JSON_PATH="${1:-}"
VAULT="${2:-${SENTRYMAIL_OP_VAULT:-Private}}"
ITEM_TITLE="${SENTRYMAIL_OP_ITEM:-SentryMail Google OAuth}"

if [[ -z "$JSON_PATH" || ! -f "$JSON_PATH" ]]; then
  echo "usage: $0 <client_secret_*.json> [vault]" >&2
  exit 1
fi
command -v op >/dev/null || { echo "1Password CLI 'op' not found" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq not found (brew install jq)" >&2; exit 1; }

CLIENT_ID="$(jq -r '.installed.client_id // .web.client_id // .client_id // empty' "$JSON_PATH")"
CLIENT_SECRET="$(jq -r '.installed.client_secret // .web.client_secret // .client_secret // empty' "$JSON_PATH")"
PROJECT_ID="$(jq -r '.installed.project_id // .web.project_id // .project_id // empty' "$JSON_PATH")"

if [[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]]; then
  echo "could not find client_id/client_secret in $JSON_PATH" >&2
  exit 1
fi

if op item get "$ITEM_TITLE" --vault "$VAULT" >/dev/null 2>&1; then
  echo "Updating existing item '$ITEM_TITLE' in vault '$VAULT'"
  op item edit "$ITEM_TITLE" --vault "$VAULT" \
    "client_id[text]=$CLIENT_ID" \
    "client_secret[concealed]=$CLIENT_SECRET" \
    "project_id[text]=$PROJECT_ID" >/dev/null
else
  echo "Creating item '$ITEM_TITLE' in vault '$VAULT'"
  op item create --category "API Credential" --vault "$VAULT" --title "$ITEM_TITLE" \
    "client_id[text]=$CLIENT_ID" \
    "client_secret[concealed]=$CLIENT_SECRET" \
    "project_id[text]=$PROJECT_ID" >/dev/null
fi

echo
echo "Stored. Reference paths:"
echo "  op://$VAULT/$ITEM_TITLE/client_id"
echo "  op://$VAULT/$ITEM_TITLE/client_secret"
echo
echo "Now run 'direnv allow' in the repo root, then 'npm run tauri dev'."
echo "You can delete the downloaded JSON: rm \"$JSON_PATH\""
