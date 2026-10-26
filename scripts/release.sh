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
usage() { echo "usage: scripts/release.sh [--publish]" >&2; exit 2; }
[ $# -le 1 ] || usage
publish=0
case "${1:-}" in
  "") ;;
  --publish) publish=1 ;;
  *) usage ;;
esac
out="${DIST:-dist}"
version=$(tr -d '[:space:]' < VERSION)
[ -n "$version" ] || { echo "VERSION is empty" >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

rm -rf "$out/cli" "$out/tap" && mkdir -p "$out/cli" "$out/tap/Formula"
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -buildvcs=false -ldflags "-s -w -X main.version=$version" -o "$work/drovr" .
touch -t 200001010000 "$work/drovr"
tar -C "$work" --format ustar --uid 0 --gid 0 --uname '' --gname '' -cf - drovr | gzip -n -9 > "$out/cli/drovr_darwin_arm64.tar.gz"
(cd "$out/cli" && shasum -a 256 drovr_darwin_arm64.tar.gz > sha256sums.txt)
sha=$(awk '{ print $1 }' "$out/cli/sha256sums.txt")
sed -e "s/__VERSION__/$version/g" -e "s/__SHA256__/$sha/g" homebrew/drovr.rb.tmpl > "$out/tap/Formula/drovr.rb"
echo "built drovr $version into $out:"
cat "$out/cli/sha256sums.txt"
[ "$publish" = 1 ] || exit 0

# Every refusal comes before the first mutation, so a refused publish leaves nothing half-done.
refuse() { echo "refusing to publish: $1" >&2; exit 1; }
branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = main ] || refuse "publish from main (on $branch)"
[ -z "$(git status --porcelain)" ] || refuse "working tree is not clean"
! git rev-parse -q --verify "refs/tags/v$version" > /dev/null || refuse "tag v$version exists"
git ls-remote --exit-code git@github.com:cadam11/homebrew-tap.git > /dev/null 2>&1 ||
  refuse "tap repo cadam11/homebrew-tap is not reachable — create it first: gh repo create cadam11/homebrew-tap --public"
rc=0; git ls-remote --exit-code --tags origin "refs/tags/v$version" > /dev/null 2>&1 || rc=$?
[ "$rc" = 2 ] || { [ "$rc" != 0 ] || refuse "tag v$version already exists on origin"; refuse "could not check origin for tag v$version"; }
# Everything below touches the network or the repo history.
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
