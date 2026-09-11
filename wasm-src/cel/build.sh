#!/usr/bin/env bash
# Builds the verifier jar the /tools/cel page runs, and regenerates the Z3
# JNI bridge table. Needs a JDK (11+), node, curl, git. Everything it
# downloads lands in .work/ (gitignored).
#
#   ./build.sh          # jar + bridge table
#   ./build-z3.sh ...   # the Z3 wasm (see that script; needs Emscripten)
set -euo pipefail

CEL_JAVA_TAG=v0.14.0
Z3_TAG=z3-4.14.1          # must match the z3-turnkey version cel-java pins
AUTO_VALUE=1.11.1

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
WORK=$HERE/.work
mkdir -p "$WORK"
cd "$WORK"

# --- dependencies, resolved by coursier (a self-contained launcher) --------
if [ ! -x coursier ]; then
  curl -sfL https://github.com/coursier/launchers/raw/master/coursier -o coursier
  chmod +x coursier
fi
./coursier fetch --classpath \
  dev.cel:cel:0.14.0 \
  tools.aqua:z3-turnkey:4.14.1 \
  com.google.auto.value:auto-value-annotations:$AUTO_VALUE \
  com.google.errorprone:error_prone_annotations:2.36.0 \
  org.jspecify:jspecify:1.0.0 > cp-runtime.txt
./coursier fetch --classpath com.google.auto.value:auto-value:$AUTO_VALUE > cp-proc.txt
CP=$(tr -d '\n' < cp-runtime.txt)
PP=$(tr -d '\n' < cp-proc.txt)

# --- the verifier sources, unmodified, at the release tag -------------------
if [ ! -d cel-java ]; then
  git clone -q --depth 1 --branch "$CEL_JAVA_TAG" --filter=blob:none --sparse https://github.com/cel-expr/cel-java.git
  (cd cel-java && git sparse-checkout set verifier)
fi

# --- compile: verifier + axioms + the REPL's core (no picocli/jline) --------
rm -rf classes && mkdir -p classes
# (paths are quoted in the argument file: the checkout may live under a
# directory with spaces in its name)
T=cel-java/verifier/src/main/java/dev/cel/verifier/tools
{ find cel-java/verifier/src/main/java -name '*.java' -not -path '*/tools/*'
  printf '%s\n' "$T/CelVerifierToolCore.java" "$T/VerificationOptions.java" "$T/FormatUtils.java" \
    "$HERE/src/dev/cel/verifier/tools/CelVerifierWeb.java"
} | sed 's/.*/"&"/' > srcs.txt
javac --release 11 -Xlint:-options -nowarn -cp "$CP" -processorpath "$PP" -d classes @srcs.txt

# The turnkey loader would try to System.load libz3; in the browser the
# natives come from JavaScript, so it becomes a no-op.
javac --release 11 -d classes "$HERE/stub/tools/aqua/turnkey/support/TurnKey.java"

# --- one jar: classes + z3's Java classes (no native libs) + dependencies ---
rm -rf fat && mkdir -p fat && cp -R classes/. fat/
Z3JAR=$(tr ':' '\n' < cp-runtime.txt | grep z3-turnkey)
(cd fat && unzip -oq "$Z3JAR" 'com/microsoft/z3/*.class')
for j in $(tr ':' '\n' < cp-runtime.txt | grep -v 'z3-turnkey\|turnkey-support'); do
  (cd fat && unzip -oq "$j" -x 'META-INF/*.SF' 'META-INF/*.RSA' 'META-INF/*.DSA' 'META-INF/*.EC' \
    'module-info.class' 'META-INF/versions/*' 'META-INF/maven/*' 'META-INF/proguard/*' 'META-INF/native-image/*' || true)
done
rm -f fat/META-INF/MANIFEST.MF
mkdir -p "$ROOT/public/cel"
rm -f "$ROOT/public/cel/cel-verifier-web.jar"
jar cf "$ROOT/public/cel/cel-verifier-web.jar" -C fat .

# --- the JNI bridge table, from Z3's headers at the matching tag -----------
mkdir -p z3-api
for h in z3_api.h z3_fpa.h z3_ast_containers.h z3_algebraic.h z3_polynomial.h z3_rcf.h z3_fixedpoint.h z3_optimization.h z3_spacer.h; do
  [ -f "z3-api/$h" ] || curl -sfL "https://raw.githubusercontent.com/Z3Prover/z3/$Z3_TAG/src/api/$h" -o "z3-api/$h"
done
node "$HERE/gen-z3-natives.mjs" z3-api "$ROOT/src/lib/cel/z3natives.json"
(cd fat && javap -p com.microsoft.z3.Native) > native-sigs.txt
node "$HERE/check-sigs.mjs" "$ROOT/src/lib/cel/z3natives.json" native-sigs.txt

ls -la "$ROOT/public/cel/cel-verifier-web.jar"
