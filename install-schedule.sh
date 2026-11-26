#!/bin/zsh
# Sets up the schedule on this Mac:
#   Every day 6:00am  Vendor Central pull (review counts, star ratings, units). Quiet unless a problem
#   Monday 6:00am     Seller Central: pull Lifepro (views.json, day "monday"), then one email
#   Tuesday 6:00am    Seller Central: pull Joyberri + Sunello (day "tuesday"), then one email
#   Wednesday 6:00am  Seller Central: pull Lifepro UK, Saudi Arabia, Turkey (day "wednesday"), then one email
#   Every day 9:00am + 1:00pm  daily check: did today's pulls work? retries failed ones, rebuilds KPIs. 9am always emails (subject starts OK or PROBLEM), 1pm only on problems
#   Every day 6:00pm  evening check (plugged in? signed in?). Emails before pull days, or if something is wrong
#
#   ./install-schedule.sh            install / update
#   ./install-schedule.sh remove     uninstall
#   ./install-schedule.sh shortcut   only (re)make the "Amazon Sign In" file on the Desktop
#
# The Mac must also WAKE itself every morning. That needs your admin password,
# so this script prints the command for you to run.
set -e
# All jobs start through node (run-job.js): macOS blocks a scheduled shell from
# opening files in Documents, but allows node.
DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
PULL="com.reviews-scraper.pull"
REMIND="com.reviews-scraper.remind"
VC="com.reviews-scraper.vc"
CHECK="com.reviews-scraper.check"
# Which node the jobs use. Homebrew: /opt/homebrew/bin/node (stays valid after upgrades).
# fnm (no-admin install): "command -v node" is a temporary folder that disappears, and then
# every job fails silently, so use the real file under ~/.local/share/fnm instead.
command -v node >/dev/null || { echo "node not found. Install Node 22.13 or newer first."; exit 1; }
NODE="$(command -v node)"
[[ "$NODE" == *fnm_multishells* ]] && NODE="$(node -p 'process.execPath')"
NODE_OK="$("$NODE" -p 'const [a,b]=process.versions.node.split(".").map(Number); a>22||(a===22&&b>=13)')"
[[ "$NODE_OK" == "true" ]] || { echo "node $("$NODE" --version) is too old. Need 22.13 or newer."; exit 1; }
[ -d "/Applications/Google Chrome.app" ] || echo "WARNING: Google Chrome is not in /Applications. The pulls need it."

# The "Amazon Sign In" file on the Desktop: double-click to sign in to every Amazon site
# that is signed out (signin.js). Made here so it always points at THIS folder and node.
write_shortcut() {
  local f="$HOME/Desktop/Amazon Sign In.command"
  {
    echo '#!/bin/zsh'
    echo '# Double-click to sign in to Seller Central and Vendor Central.'
    echo '# Chrome opens only for what is signed out; you type the password and code.'
    echo '# Made by install-schedule.sh. To remake it: ./install-schedule.sh shortcut'
    echo "cd \"$DIR\" || exit 1"
    echo "\"$NODE\" signin.js"
    echo 'echo'
    echo 'echo "You can close this window."'
  } > "$f"
  chmod +x "$f"
  echo "Desktop shortcut: $f"
}

if [[ "$1" == "shortcut" ]]; then write_shortcut; exit 0; fi

unload() { launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || true; rm -f "$AGENTS/$1.plist"; }

if [[ "$1" == "remove" ]]; then
  unload $PULL; unload $REMIND; unload $VC; unload $CHECK
  echo "Schedule removed. To stop the morning wake too: sudo pmset repeat cancel"
  exit 0
fi

mkdir -p "$AGENTS" "$DIR/logs"

# $1 label, $2 weekdays (e.g. "1 2"; 0=Sun,1=Mon,2=Tue), $3 hour(s) (e.g. "9 13"), $4 program args (xml)
write_agent() {
local times=""
for d in ${=2}; do
  for h in ${=3}; do
    times+="<dict><key>Weekday</key><integer>$d</integer><key>Hour</key><integer>$h</integer><key>Minute</key><integer>0</integer></dict>"
  done
done
cat > "$AGENTS/$1.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key><array>$4</array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>StartCalendarInterval</key><array>$times</array>
  <key>StandardOutPath</key><string>$DIR/logs/launchd-$1.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/launchd-$1.log</string>
</dict></plist>
EOF
  launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/$1.plist"
}

write_agent $PULL "1 2 3" 6 "<string>$NODE</string><string>$DIR/run-job.js</string><string>pull</string>"
write_agent $VC "0 1 2 3 4 5 6" 6 "<string>$NODE</string><string>$DIR/run-job.js</string><string>vc</string>"
write_agent $CHECK "0 1 2 3 4 5 6" "9 13" "<string>$NODE</string><string>$DIR/run-job.js</string><string>check</string>"
write_agent $REMIND "0 1 2 3 4 5 6" 18 "<string>$NODE</string><string>$DIR/remind.js</string>"

write_shortcut

echo "Installed: daily 6:00am Vendor Central pull, Monday + Tuesday + Wednesday 6:00am review pulls, daily 9:00am + 1:00pm morning check, daily 6:00pm evening check."
echo ""
echo "Now make the Mac wake itself every morning (asks for your Mac password):"
echo ""
echo "  sudo pmset repeat wakeorpoweron MTWRFSU 05:55:00"
echo ""
echo "Check it with: pmset -g sched"
echo "Note: macOS allows ONE repeating wake schedule. This replaces any you had."
