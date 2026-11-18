#!/bin/zsh
# Sets up the weekly schedule on this Mac:
#   Sunday 6:00pm  reminder (Mac notification + Telegram if set up)
#   Monday 6:00am  the pull, then a summary or failure message
#
#   ./install-schedule.sh            install / update
#   ./install-schedule.sh remove     uninstall
#
# The Mac must also WAKE itself on Monday. That needs your admin password,
# so this script prints the command for you to run.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
PULL="com.reviews-scraper.pull"
REMIND="com.reviews-scraper.remind"
NODE="$(command -v node)"

unload() { launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || true; rm -f "$AGENTS/$1.plist"; }

if [[ "$1" == "remove" ]]; then
  unload $PULL; unload $REMIND
  echo "Schedule removed. To stop the Monday wake too: sudo pmset repeat cancel"
  exit 0
fi

mkdir -p "$AGENTS" "$DIR/logs"
chmod +x "$DIR/run-pull.sh"

# $1 label, $2 weekday (0=Sun,1=Mon), $3 hour, $4 program args (xml)
write_agent() {
cat > "$AGENTS/$1.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key><array>$4</array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>StartCalendarInterval</key><dict>
    <key>Weekday</key><integer>$2</integer>
    <key>Hour</key><integer>$3</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key><string>$DIR/logs/launchd-$1.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/launchd-$1.log</string>
</dict></plist>
EOF
  launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/$1.plist"
}

write_agent $PULL 1 6 "<string>/bin/zsh</string><string>$DIR/run-pull.sh</string>"
write_agent $REMIND 0 18 "<string>$NODE</string><string>$DIR/remind.js</string>"

echo "Installed: Sunday 6:00pm reminder, Monday 6:00am pull."
echo ""
echo "Now make the Mac wake itself on Mondays (asks for your Mac password):"
echo ""
echo "  sudo pmset repeat wakeorpoweron M 05:55:00"
echo ""
echo "Check it with: pmset -g sched"
echo "Note: macOS allows ONE repeating wake schedule. This replaces any you had."
