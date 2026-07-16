#!/bin/sh
# Run the bridge spike against a local XMage server (start that first).
# Uses the dist's bundled JRE 8 by default; override with JAVA=/path/to/java.
set -e
cd "$(dirname "$0")/.."
LIB="vendor/xmage-dist/xmage/mage-client/lib"
if [ -z "$JAVA" ]; then
    JAVA=$(echo vendor/xmage-dist/java/*/bin/java)
fi
exec "$JAVA" -Djava.awt.headless=true -cp "bridge/out:$LIB/*" night.spike.SpikeMain "$@"
