#!/bin/bash
# Double-click this if the link ever stops working, to restart everything.
echo "Restarting Crew Clock services..."
launchctl kickstart -k "gui/$(id -u)/com.crewclock.server" 2>/dev/null
launchctl kickstart -k "gui/$(id -u)/com.crewclock.tunnel" 2>/dev/null
echo "Done. Waiting for the link..."
sleep 12
LOG="$HOME/Desktop/crew-clock/logs/tunnel.log"
URL=$(grep -Eo "https://[a-z0-9-]+\.trycloudflare\.com" "$LOG" 2>/dev/null | tail -1)
echo ""
echo "  New link: $URL"
echo "  Dashboard: $URL/admin   (PIN 2101)"
printf "%s" "$URL" | pbcopy
echo "  ✓ copied to clipboard"
echo ""
echo "  (You can close this window.)"
