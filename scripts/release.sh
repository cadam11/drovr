#!/bin/sh
# Builds the darwin_arm64 CLI into $DIST/cli (default dist/) and renders the Homebrew formula into
# $DIST/tap/Formula. Without --publish it only writes local files; --publish tags, releases and
# pushes the tap.
#
# Deterministic on purpose: the version comes from VERSION (never the commit), the binary's mtime
# is pinned, tar carries uid/gid 0 and no names, gzip -n writes no timestamp — so the same version
# yields the same bytes and the formula's sha256 is reproducible.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
publish=0
[ "${1:-}" = "--publish" ] && publish=1
[ $# -le 1 ] || { echo "usage: release.sh [--publish]" >&2; exit 2; }
out="${DIST:-dist}"
version=$(tr -d '[:space:]' < VERSION)
[ -n "$version" ] || { echo "VERSION is empty" >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

rm -rf "$out/cli" "$out/tap" && mkdir -p "$out/cli" "$out/tap/Formula"
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags "-s -w -X main.version=$version" -o "$work/drovr" .
touch -t 200001010000 "$work/drovr"
tar -C "$work" --format ustar --uid 0 --gid 0 --uname '' --gname '' -cf - drovr | gzip -n -9 > "$out/cli/drovr_darwin_arm64.tar.gz"
(cd "$out/cli" && shasum -a 256 drovr_darwin_arm64.tar.gz > sha256sums.txt)
sha=$(awk '{ print $1 }' "$out/cli/sha256sums.txt")
sed -e "s/__VERSION__/$version/g" -e "s/__SHA256__/$sha/g" homebrew/drovr.rb.tmpl > "$out/tap/Formula/drovr.rb"
echo "built drovr $version into $out:"
cat "$out/cli/sha256sums.txt"
[ "$publish" = 1 ] || exit 0

# Everything below touches the network or the repo history.
[ -z "$(git status --porcelain)" ] || { echo "refusing to publish: working tree is not clean" >&2; exit 1; }
if git rev-parse -q --verify "refs/tags/v$version" > /dev/null; then
  echo "refusing to publish: tag v$version exists" >&2
  exit 1
fi
# Notes cover everything since the latest release tag, or the whole history if there is none.
prev=$(git tag --list 'v*' --sort=-v:refname | head -n 1)
[ -n "$prev" ] || prev=$(git rev-list --max-parents=0 HEAD | tail -n 1)
git log --oneline "$prev..HEAD" > "$work/notes.txt"
git tag "v$version"
git push origin main "v$version"
gh release create "v$version" "$out/cli/drovr_darwin_arm64.tar.gz" "$out/cli/sha256sums.txt" --title "v$version" --notes-file "$work/notes.txt"
git clone git@github.com:cadam11/homebrew-tap.git "$work/tap"
mkdir -p "$work/tap/Formula"
cp "$out/tap/Formula/drovr.rb" "$work/tap/Formula/drovr.rb"
git -C "$work/tap" add Formula/drovr.rb
git -C "$work/tap" commit -m "drovr $version"
git -C "$work/tap" push
