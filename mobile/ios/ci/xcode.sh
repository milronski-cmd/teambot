#!/usr/bin/env bash
# Select the Xcode for this build. App Store Connect only accepts uploads built with Xcode 26 or later and the
# iOS 26 SDK (since 28 April 2026), and never with a beta. Default: the newest non-beta Xcode >= 26 on the runner.
# Pin one with the repository variable XCODE_VERSION (for example 26.6): bash ci/xcode.sh 26.6
set -euo pipefail

want="${1:-}"
app=""

# The newest non-beta Xcode >= 26 on the runner. A function, not inline in $( ): macOS ships bash 3.2, which cannot
# parse a `case … in pattern)` inside a command substitution.
pick_latest() {
  local a v major rest minor patch
  for a in /Applications/Xcode_*.app; do
    [ -d "$a" ] || continue
    v="${a#/Applications/Xcode_}"
    v="${v%.app}"
    case "$v" in
      *[Bb]eta*) continue ;;
    esac
    major="${v%%.*}"
    case "$major" in
      '' | *[!0-9]*) continue ;;
    esac
    rest="${v#*.}"
    [ "$rest" = "$v" ] && rest="0"
    minor="${rest%%.*}"
    patch="${rest#*.}"
    [ "$patch" = "$rest" ] && patch="0"
    if [ "$major" -ge 26 ]; then echo "$major ${minor:-0} ${patch:-0} $a"; fi
  done | sort -k1,1n -k2,2n -k3,3n | tail -1 | cut -d' ' -f4-
}

if [ -n "$want" ]; then
  app="/Applications/Xcode_${want}.app"
  if [ ! -d "$app" ]; then
    echo "::error::Xcode ${want} staat niet op deze runner. Beschikbaar:"
    ls -d /Applications/Xcode_*.app || true
    exit 1
  fi
else
  app=$(pick_latest)
fi

if [ -z "$app" ]; then
  echo "::error::Geen Xcode 26 of nieuwer (zonder beta) op deze runner gevonden."
  ls -d /Applications/Xcode_*.app || true
  exit 1
fi

sudo xcode-select -s "$app/Contents/Developer"
xcodebuild -version
major=$(xcodebuild -version | awk 'NR==1 { print $2 }' | cut -d. -f1)
if [ "$major" -lt 26 ]; then
  echo "::error::Xcode 26 of nieuwer nodig (gevonden: $(xcodebuild -version | head -1))"
  exit 1
fi
xcrun --sdk iphoneos --show-sdk-version
