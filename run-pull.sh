#!/bin/zsh
# Called by the Monday schedule. Keeps the Mac awake while it runs, logs output.
cd "$(dirname "$0")"
mkdir -p logs
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
caffeinate -i node scrape.js >>"logs/pull-$(date +%Y-%m-%d).log" 2>&1
