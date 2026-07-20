#!/bin/sh
# Install the XMage dist's jars into the local Maven repository so the bridge
# can depend on them (they are not published to Maven Central).
#
# Compiling against the dist's own jars is what guarantees the exact
# MageVersion handshake with the server from the same dist (design §1).
# Coordinates mirror the ones XMage's own poms use, so a future switch to a
# source build would resolve identically. Versions are pinned; re-run after
# replacing vendor/xmage-dist with a new dist (and bump xmage.version in
# pom.xml to match).
set -e
cd "$(dirname "$0")/.."
LIB="vendor/xmage-dist/xmage/mage-client/lib"

install() {
    mvn -q install:install-file \
        -Dfile="$LIB/$1" \
        -DgroupId="$2" -DartifactId="$3" -Dversion="$4" \
        -Dpackaging=jar -DgeneratePom=true
    echo "installed $2:$3:$4"
}

# XMage itself (compile deps)
install mage-1.4.60.jar               org.mage           mage              1.4.60
install mage-common-1.4.60.jar        org.mage           mage-common       1.4.60

# Per-card implementation classes (CardInfo#createCard looks these up by name via
# Class.forName — needed wherever a resolved card must answer ability questions,
# e.g. the commander-pairing validators in deck import).
install mage-sets-1.4.60.jar          org.mage           mage-sets         1.4.60

# JBoss Remoting transport stack (runtime deps of mage.remote)
install jboss-remoting-2.5.4.SP5.jar  org.jboss.remoting jboss-remoting    2.5.4.SP5
install jboss-common-core-2.5.0.Final.jar org.jboss      jboss-common-core 2.5.0.Final
install jboss-serialization-4.2.2.GA.jar  jboss          jboss-serialization 4.2.2.GA
install jboss-logging-spi-2.1.2.GA.jar org.jboss.logging jboss-logging-spi 2.1.2.GA
install concurrent-1.3.4.jar          concurrent         concurrent        1.3.4
install trove-1.0.2.jar               trove              trove             1.0.2

# Plugin framework referenced by mage-common
install jspf-core-0.9.1.jar           com.googlecode.jspf jspf-core        0.9.1

# Card database stack (CardRepository — deck import resolves names through it)
install h2-1.4.197.jar                com.h2database     h2                1.4.197
install ormlite-core-5.7.jar          com.j256.ormlite   ormlite-core      5.7
install ormlite-jdbc-5.7.jar          com.j256.ormlite   ormlite-jdbc      5.7

echo "done — bridge/pom.xml can now resolve the XMage stack"
