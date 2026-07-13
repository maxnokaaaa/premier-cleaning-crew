#!/bin/bash
# Double-click this any time to see (and copy) your current Crew Clock link.
LOG="$HOME/Desktop/crew-clock/logs/tunnel.log"
URL=$(grep -Eo "https://[a-z0-9-]+\.trycloudflare\.com" "$LOG" 2>/dev/null | tail -1)

echo ""
echo "  ========================================================"
if [ -z "$URL" ]; then
  echo "   Link not ready yet. Make sure the Mac is on, wait 20s,"
  echo "   then double-click this again."
else
  echo "   YOUR CREW CLOCK LINK  (paste this into WhatsApp):"
  echo ""
  echo "   $URL"
  echo ""
  echo "   Owner dashboard:  $URL/admin"
  echo "   Owner PIN:        2101"
  printf "%s" "$URL" | pbcopy
  echo ""
  echo "   ✓ Link copied to your clipboard."
fi
echo "  ========================================================"
echo ""
echo "  (You can close this window.)"
