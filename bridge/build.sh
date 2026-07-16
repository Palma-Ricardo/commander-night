#!/bin/sh
# Compile the bridge spike against the XMage distribution's client jars.
# Targets Java 8 bytecode so it can run on the dist's bundled JRE.
set -e
cd "$(dirname "$0")/.."
LIB="vendor/xmage-dist/xmage/mage-client/lib"
mkdir -p bridge/out
javac --release 8 -cp "$LIB/*" -d bridge/out bridge/src/night/spike/SpikeMain.java
echo "build ok -> bridge/out"
