#!/usr/bin/env bash
# Builds what the /tools/pluscal page runs: the official tla2tools.jar
# (PlusCal translator, SANY, TLC), unmodified, plus two small jars of glue.
# Needs a JDK (11+) and curl. Downloads land in .work/ (gitignored); outputs
# are committed under public/pluscal.
#
#   ./build.sh            # fetch the pinned jar, build the glue, run the JVM checks
set -euo pipefail

# The TLA+ nightly ("v1.8.0" is re-published continuously); pinned by hash.
TLA2TOOLS_URL=https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar
TLA2TOOLS_SHA256=7beec0f04818732a62fa193731711a99aa4f11279499b2360a7d156c519ea78d   # rev 94d0c50, 2026-10-06

# tla2tools.jar's manifest puts these on its Class-Path, as every TLA+
# distribution ships them: the TLA+ Community Modules and their dependencies.
COMMUNITY_TAG=202610040242
COMMUNITY_SHA256=b7fcd727fc5135a628e56d5015651c74ba70681bbaf88df1cd59e9afa64215ad
COMMUNITY_DEPS_SHA256=dddb19c3d7596913d92c43073b60d1408ac8f6d86716af4d19dd6861a95bfb7d

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
WORK=$HERE/.work
OUT=$ROOT/public/pluscal
mkdir -p "$WORK" "$OUT"
cd "$WORK"

fetch() { # url file sha256
  if [ ! -f "$2" ] || ! echo "$3  $2" | shasum -a 256 -c --status; then
    curl -sfL "$1" -o "$2"
    echo "$3  $2" | shasum -a 256 -c --status || {
      echo "$2 does not match its pinned hash (a re-published release?)." >&2
      echo "Check the new build, then update the hash in build.sh." >&2
      exit 1
    }
  fi
}
fetch "$TLA2TOOLS_URL" tla2tools.jar "$TLA2TOOLS_SHA256"
CM=https://github.com/tlaplus/CommunityModules/releases/download/$COMMUNITY_TAG
fetch "$CM/CommunityModules-$COMMUNITY_TAG.jar" CommunityModules.jar "$COMMUNITY_SHA256"
fetch "$CM/CommunityModules-deps-$COMMUNITY_TAG.jar" CommunityModules-deps.jar "$COMMUNITY_DEPS_SHA256"

# --- runner: compiled against tla2tools, loaded beside it per run ----------
rm -rf runner-classes web-classes && mkdir -p runner-classes web-classes
javac --release 11 -nowarn -cp tla2tools.jar -d runner-classes \
  "$HERE/runner/site/pluscal/runner/PlusCalRunner.java"
# --- facade: the JS-facing class; it must not see tla2tools itself ---------
javac --release 11 -nowarn -d web-classes "$HERE"/src/site/pluscal/*.java

cp tla2tools.jar CommunityModules.jar CommunityModules-deps.jar "$OUT/"
jar cf "$OUT/pluscal-runner.jar" -C runner-classes .
jar cf "$OUT/pluscal-web.jar" -C web-classes .

# --- the same calls the page makes, on a real JVM ---------------------------
javac --release 11 -nowarn -cp web-classes -d web-test "$HERE/test/site/pluscal/JvmCheck.java"
java -Duser.home="$WORK/jvm-home" -cp "web-classes:web-test" site.pluscal.JvmCheck "$OUT/tla2tools.jar" "$OUT/pluscal-runner.jar" "$WORK/jvm-runs"

ls -la "$OUT"
