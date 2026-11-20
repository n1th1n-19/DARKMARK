#!/bin/sh
# Install or update darkmark to the latest GitHub release, in every VS Code / VSCodium found on PATH.
#   curl -fsSL https://raw.githubusercontent.com/n1th1n-19/DARKMARK/main/update.sh | sh
set -eu

repo=n1th1n-19/DARKMARK
url=$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" |
  grep -o '"browser_download_url": *"[^"]*\.vsix"' | head -n 1 | cut -d '"' -f 4)
[ -n "$url" ] || { echo "darkmark: no .vsix found in the latest release" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
vsix="$tmp/${url##*/}"
echo "darkmark: downloading ${url##*/}"
curl -fsSL -o "$vsix" "$url"

clis=''
for cli in code codium code-insiders codium-insiders; do
  command -v "$cli" >/dev/null 2>&1 && clis="$clis $cli"
done
[ -n "$clis" ] || { echo "darkmark: no code or codium command on PATH" >&2; exit 1; }

# Update only the editors that already have darkmark; if none has it yet, install into all of them
targets=''
for cli in $clis; do
  "$cli" --list-extensions 2>/dev/null | grep -qix 'n1th1n-19\.darkmark' && targets="$targets $cli"
done
[ -n "$targets" ] || targets=$clis

for cli in $targets; do
  echo "darkmark: installing into $cli"
  "$cli" --install-extension "$vsix" --force
done
echo "darkmark: done. Reload open windows (Developer: Reload Window) to use the new version."
