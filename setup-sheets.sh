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
#   ./setup-sheets.sh keepa     -> saves the Keepa sheet ID (sheet "Review History - Keepa")
#   ./setup-sheets.sh copy      -> moving to a new Mac: writes local/move-secrets.sh, which puts
#                                  the SAME secrets in the new Mac's Keychain. AirDrop it, run it
#                                  there once, then delete it on both Macs.
#                                  Never run "token" on the new Mac: a new token breaks the sheet.
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
  keepa)       ask keepa-sheet-id "Paste the Keepa sheet ID (the part of its link between /d/ and /edit):" ;;
  copy)
    mkdir -p "$(dirname "$0")/local"
    OUT="$(dirname "$0")/local/move-secrets.sh"
    umask 077
    {
      echo '#!/bin/zsh'
      echo '# Puts the review scraper secrets in this Mac Keychain. Run once, then delete this file.'
      for k in sheets-url sheets-token keepa-sheet-id telegram-token telegram-chat healthcheck-url; do
        v="$(security find-generic-password -s "$SERVICE" -a "$k" -w 2>/dev/null)" || continue
        print -r -- "security add-generic-password -U -s ${(q)SERVICE} -a ${(q)k} -w ${(q)v}"
      done
      echo 'echo "Saved. Now delete this file."'
    } > "$OUT"
    chmod 700 "$OUT"
    echo "Written: $OUT"
    echo "It holds secrets: AirDrop it, run it on the new Mac, then delete it on both Macs."
    ;;
  *) echo "Use: ./setup-sheets.sh token | url | script | telegram | healthcheck | keepa | copy"; exit 1 ;;
esac
