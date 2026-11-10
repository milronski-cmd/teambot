#!/usr/bin/env python3
"""Print the UDID of an available iPhone simulator on the newest iOS runtime (for `xcodebuild test`).

Usage: xcrun simctl list devices available -j | python3 -I ci/simulator.py
"""
import json
import re
import sys


def main() -> int:
    devices = json.load(sys.stdin).get("devices", {})
    best = None
    for runtime, entries in devices.items():
        m = re.search(r"iOS-(\d+)-(\d+)", runtime)
        if not m:
            continue
        version = (int(m.group(1)), int(m.group(2)))
        for d in entries:
            if d.get("isAvailable", True) and str(d.get("name", "")).startswith("iPhone"):
                if best is None or version > best[0]:
                    best = (version, d["udid"], d["name"])
    if best is None:
        print("::error::Geen iPhone-simulator gevonden op deze runner.", file=sys.stderr)
        return 1
    print(f"Simulator: {best[2]} (iOS {best[0][0]}.{best[0][1]})", file=sys.stderr)
    print(best[1])
    return 0


if __name__ == "__main__":
    sys.exit(main())
