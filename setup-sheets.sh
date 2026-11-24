#!/bin/zsh
# Connects the Mac to your Google Sheet. Run it yourself in Terminal.
#
#   ./setup-sheets.sh token     -> makes a secret token and shows it ONCE
#                                  (paste it into Code.gs as TOKEN)
#   ./setup-sheets.sh url       -> saves the web app URL (after you deploy)
#   ./setup-sheets.sh script    -> writes local/Code-for-sheet.gs: Code.gs with the
#                                  token and Keepa sheet ID filled in, ready to paste
#   ./setup-sheets.sh telegram  -> optional: Telegram bot token + chat ID
#   ./setup-sheets.sh healthcheck -> optional: healthchecks.io ping URL
set -e
SERVICE="amazon-review-scraper"
put() { security add-generic-password -U -s "$SERVICE" -a "$1" -w "$2"; }
ask() { echo ""; echo "$2"; security add-generic-password -U -s "$SERVICE" -a "$1" -w; echo "Saved."; }

case "$1" in
  token)
    T="$(openssl rand -hex 24)"
    put sheets-token "$T"
    echo ""
    echo "Paste this into apps-script/Code.gs (in the Apps Script editor) as TOKEN:"
    echo ""
    echo "  $T"
    echo ""
    ;;
  script)
    mkdir -p "$(dirname "$0")/local"
    OUT="$(dirname "$0")/local/Code-for-sheet.gs"
    TOKEN="$(security find-generic-password -s "$SERVICE" -a sheets-token -w)"
    KEEPA="$(security find-generic-password -s "$SERVICE" -a keepa-sheet-id -w)"
    sed -e "s/'PASTE-TOKEN-HERE'/'$TOKEN'/" -e "s/'PASTE-KEEPA-SHEET-ID-HERE'/'$KEEPA'/" "$(dirname "$0")/apps-script/Code.gs" > "$OUT"
    echo "Ready to paste: $OUT"
    ;;
  url)         ask sheets-url "Paste the web app URL (ends in /exec):" ;;
  telegram)    ask telegram-token "Telegram bot token:"; ask telegram-chat "Telegram chat ID:" ;;
  healthcheck) ask healthcheck-url "Healthchecks.io ping URL:" ;;
  *) echo "Use: ./setup-sheets.sh token | url | script | telegram | healthcheck"; exit 1 ;;
esac
