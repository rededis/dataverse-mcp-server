#!/usr/bin/env bash
# Downloads a release archive, checks it against a sha256 and extracts one
# file from it (ADR-0003 §1). The ci workflow installs its release binaries
# with it (#157); each step passes its own URL, digest and file.
#
#   fetch-verified.sh <url> <sha256> <file in archive> <directory>
#
# The archive and the file land in <directory>. A digest that does not match
# fails the script before anything is extracted.
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <url> <sha256> <file in archive> <directory>" >&2
  exit 64
fi

url=$1
sha256=$2
member=$3
dir=$4
archive="$dir/${url##*/}"

curl -fsSL --retry 3 -o "$archive" "$url"
echo "$sha256  $archive" | sha256sum --check --strict
tar -xzf "$archive" -C "$dir" "$member"
