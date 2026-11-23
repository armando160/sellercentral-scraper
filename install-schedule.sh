#!/bin/zsh
# Sets up the schedule on this Mac:
#   Every day 6:00am  Vendor Central pull (review counts, star ratings, units). Quiet unless a problem
#   Monday 6:00am     Seller Central: pull Lifepro (views.json, day "monday"), then one email
#   Tuesday 6:00am    Seller Central: pull Joyberri + Sunello (day "tuesday"), then one email
#   Every day 9:00am + 1:00pm  daily check: did today's pulls work? retries failed ones, rebuilds KPIs. 9am always emails (subject starts OK or PROBLEM), 1pm only on problems
#   Every day 6:00pm  evening check (plugged in? signed in?). Emails before pull days, or if something is wrong
#
#   ./install-schedule.sh            install / update
#   ./install-schedule.sh remove     uninstall
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
NODE="$(command -v node)"

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

write_agent $PULL "1 2" 6 "<string>$NODE</string><string>$DIR/run-job.js</string><string>pull</string>"
write_agent $VC "0 1 2 3 4 5 6" 6 "<string>$NODE</string><string>$DIR/run-job.js</string><string>vc</string>"
write_agent $CHECK "0 1 2 3 4 5 6" "9 13" "<string>$NODE</string><string>$DIR/run-job.js</string><string>check</string>"
write_agent $REMIND "0 1 2 3 4 5 6" 18 "<string>$NODE</string><string>$DIR/remind.js</string>"

echo "Installed: daily 6:00am Vendor Central pull, Monday + Tuesday 6:00am review pulls, daily 9:00am + 1:00pm morning check, daily 6:00pm evening check."
echo ""
echo "Now make the Mac wake itself every morning (asks for your Mac password):"
echo ""
echo "  sudo pmset repeat wakeorpoweron MTWRFSU 05:55:00"
echo ""
echo "Check it with: pmset -g sched"
echo "Note: macOS allows ONE repeating wake schedule. This replaces any you had."
