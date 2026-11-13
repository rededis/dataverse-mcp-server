#!/usr/bin/env bash
# Scans commits for environment hosts and tenant or client IDs with the
# rules in .betterleaks.toml (#124): their diffs, a merge commit against its
# first parent, and their messages. The ci job and the pre-push hook both
# call it (#167), so the two scans cannot drift apart.
#
#   scan-commits.sh <betterleaks binary> <git log revisions>...
#
# The revisions are what git log takes: HEAD for the whole history, or
# <commit> --not --remotes=origin for the commits a push adds. They go to
# Betterleaks as one string, so none may contain a space.
# It runs from the root of the repository, wherever it is called from: the
# rules file is read from there. So the binary is an absolute path or a name
# on PATH, not a path relative to another directory.
# Findings show the file, commit and line, the match itself redacted; a
# finding in a message is printed under the line `commit <sha>` that
# precedes it. Both scans run; either fails the script, as does a failing
# git log.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <betterleaks binary> <git log revisions>..." >&2
  exit 64
fi

betterleaks=$1
shift

# Assigned first: a failing rev-parse stops the script here, not at the scans.
root=$(git rev-parse --show-toplevel)
cd "$root"

scan=("$betterleaks" --config .betterleaks.toml --redact --verbose --no-banner)
status=0
"${scan[@]}" git . --log-opts="--diff-merges=first-parent $*" || status=1
git log --format='commit %H%n%B' "$@" | "${scan[@]}" stdin || status=1
exit "$status"
