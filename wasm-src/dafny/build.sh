#!/usr/bin/env bash
# Builds the Dafny-in-the-browser host and refreshes public/dafny/_framework.
#
# Needs the .NET 9 SDK with the wasm-tools workload:
#   curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 9.0
#   ~/.dotnet/dotnet workload install wasm-tools
set -euo pipefail

cd "$(dirname "$0")"
SITE_ROOT="$(cd ../.. && pwd)"
DEST="$SITE_ROOT/public/dafny/_framework"

rm -rf bin obj
dotnet publish -c Release

rm -rf "$DEST"
mkdir -p "$DEST"
# Skip the pre-compressed variants; the CDN handles compression.
find bin/Release/net9.0/publish/wwwroot/_framework -type f \
  ! -name "*.br" ! -name "*.gz" -exec cp {} "$DEST/" \;

echo "refreshed $DEST"
