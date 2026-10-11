#!/bin/bash
# Frame TV HDMI re-handshake watcher.
#
# The Samsung Frame keeps HDMI hot-plug asserted while it is off, so when it
# powers back on the Mac never re-negotiates the link (scrambling/HDCP) and
# the TV reports "no HDMI". This polls the TV's local API and, on an
# off -> on transition, forces a full modeset by briefly switching the
# refresh rate (60 Hz -> 30 Hz -> back), which retrains the link exactly
# like replugging the cable does.
#
# Usage:
#   frame-tv-watch.sh          run the watcher loop (LaunchAgent)
#   frame-tv-watch.sh reset    force one re-handshake now
#   frame-tv-watch.sh status   print the TV's current power state
#
# Install (on the frame Mac, as the GUI user; needs BetterDisplay running):
#   mkdir -p ~/bin && cp macos/frame-tv-watch.sh ~/bin/ && chmod +x ~/bin/frame-tv-watch.sh
#   cp macos/com.pictureframe.tvwatch.plist ~/Library/LaunchAgents/
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pictureframe.tvwatch.plist
# TV_IP and DISPLAY_TAG (betterdisplaycli get -identifiers) are machine-specific.

TV_IP="192.168.5.50"
TV_API="http://${TV_IP}:8001/api/v2/"
BD="/opt/homebrew/bin/betterdisplaycli"
DISPLAY_TAG="2"          # BetterDisplay tagID of the SAMSUNG display
ALT_MODE="102"           # 3840x2160 (HiDPI 1920x1080) @ 30 Hz
FALLBACK_MODE="98"       # 3840x2160 (HiDPI 1920x1080) @ 60 Hz, the normal mode
POLL_SECONDS=3
WAKE_DELAY_SECONDS=6     # let the TV's HDMI receiver come up first
MIN_RESET_GAP_SECONDS=60
LOG="$HOME/Library/Logs/frame-tv-watch.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

tv_state() {
    local body
    body=$(curl -s -m 2 "$TV_API") || { echo "unreachable"; return; }
    local state
    state=$(printf '%s' "$body" | grep -o '"PowerState": *"[A-Za-z]*"' | head -1 | sed -E 's/.*"([A-Za-z]*)"$/\1/')
    echo "${state:-unknown}"
}

rehandshake() {
    local current
    current=$("$BD" get -tagID="$DISPLAY_TAG" -displayModeNumber 2>/dev/null)
    if ! [[ "$current" =~ ^[0-9]+$ ]]; then
        log "reset: could not read display mode (is BetterDisplay running?) got='$current'"
        current="$FALLBACK_MODE"
    fi
    local alt="$ALT_MODE"
    [ "$current" = "$ALT_MODE" ] && alt="$FALLBACK_MODE"

    log "reset: mode $current -> $alt -> $current"
    "$BD" set -tagID="$DISPLAY_TAG" -displayModeNumber="$alt" >> "$LOG" 2>&1
    sleep 3
    "$BD" set -tagID="$DISPLAY_TAG" -displayModeNumber="$current" >> "$LOG" 2>&1
    sleep 2
    local after
    after=$("$BD" get -tagID="$DISPLAY_TAG" -displayModeNumber 2>/dev/null)
    if [ "$after" != "$current" ]; then
        log "reset: mode is '$after', expected '$current'; retrying restore"
        "$BD" set -tagID="$DISPLAY_TAG" -displayModeNumber="$current" >> "$LOG" 2>&1
    fi
    log "reset: done (mode $("$BD" get -tagID="$DISPLAY_TAG" -displayModeNumber 2>/dev/null))"
}

case "$1" in
    reset)  rehandshake; exit 0 ;;
    status) tv_state; exit 0 ;;
esac

log "watcher started (TV $TV_IP)"
last_state=$(tv_state)
log "initial TV state: $last_state"
last_reset=0

while true; do
    sleep "$POLL_SECONDS"
    state=$(tv_state)
    [ "$state" = "$last_state" ] && continue

    log "TV state: $last_state -> $state"
    if [ "$state" = "on" ]; then
        now=$(date +%s)
        if (( now - last_reset >= MIN_RESET_GAP_SECONDS )); then
            sleep "$WAKE_DELAY_SECONDS"
            rehandshake
            last_reset=$(date +%s)
        else
            log "skip reset: last one was $(( now - last_reset ))s ago"
        fi
    fi
    last_state="$state"
done
