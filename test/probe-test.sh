#!/bin/sh
# Runs the real probe script against real fixtures, because asserting that the
# script contains a flag is not the same as showing what it does. Everything
# here is local: no network, and nothing that needs a Spotify.
#
#   sh test/probe-test.sh
#
# Skips if ImageMagick is missing, which is also the case where the plugin
# quietly does without a cover backdrop.

set -eu

cd "$(dirname "$0")/.."

if ! command -v magick >/dev/null 2>&1; then
  echo "skip — ImageMagick not installed"
  exit 0
fi
if ! command -v node >/dev/null 2>&1; then
  echo "skip — node not installed"
  exit 0
fi

script=$(node -e 'process.stdout.write(require("./Model.js").artProbeScript())')
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

failures=0

probe() {
  sh -c "$script" sh "$1" >/dev/null 2>&1
}

expect_ok() {
  if probe "$1"; then
    echo "ok       $2"
  else
    echo "FAIL     $2 — expected the probe to read this"
    failures=$((failures + 1))
  fi
}

expect_refused() {
  if probe "$1"; then
    echo "FAIL     $2 — expected the probe to refuse this"
    failures=$((failures + 1))
  else
    echo "refused  $2"
  fi
}

# A cover, and a cover whose name has a space in it.
magick -size 200x200 xc:'#1db954' "$work/cover.png"
expect_ok "$work/cover.png" "a PNG cover"
cp "$work/cover.png" "$work/My Cover.png"
expect_ok "$work/My Cover.png" "a cover with a space in its name"

magick -size 200x200 xc:'#b2313a' "$work/cover.jpg"
expect_ok "$work/cover.jpg" "a JPEG cover"

# Formats that reach an ImageMagick delegate or coder rather than a raster
# decoder. The magic-byte check is what keeps these out.
printf 'not an image at all\n' > "$work/text.txt"
expect_refused "$work/text.txt" "a plain text file"

printf '%s' '<svg xmlns="http://www.w3.org/2000/svg"><image href="/etc/passwd"/></svg>' > "$work/evil.svg"
expect_refused "$work/evil.svg" "an SVG referencing a local file"

printf '%s' 'push graphic-context image over 0,0 0,0 "msl:/etc/passwd" pop graphic-context' > "$work/evil.mvg"
expect_refused "$work/evil.mvg" "an MVG vector script"

# Past the byte bound, with a JPEG signature so only the size can catch it.
printf '\377\330\377' > "$work/big.jpg"
head -c 9000000 /dev/zero >> "$work/big.jpg"
expect_refused "$work/big.jpg" "a 9MB file past the size bound"

# 410KB on disk, 144 megapixels decoded — roughly 430MB of pixels if nothing
# stops it. This is the case the byte bounds cannot catch, so it is the one
# that shows the area limit doing the work.
node test/make-bomb.js "$work/bomb.png" 12000
expect_refused "$work/bomb.png" "a 12000x12000 decompression bomb"

expect_refused "$work/does-not-exist.png" "a path that is not there"

# The cover the panel is allowed to display: written here, not fetched by Qt,
# and capped so that decoding it is bounded too.
oversized="$work/oversized.png"
magick -size 3000x2000 gradient:'#204080-#c0f0ff' "$oversized"
art=$(sh -c "$script" sh "$oversized" | sed -n 's/^ART //p')
if [ -z "$art" ] || [ ! -f "$art" ]; then
  echo "FAIL     the probe did not write a cover for the panel to show"
  failures=$((failures + 1))
else
  kind=$(od -An -v -tx1 -N8 "$art" | tr -d " \n")
  case "$kind" in
    89504e470d0a1a0a*) echo "ok       the written cover is a PNG" ;;
    *) echo "FAIL     the written cover is not a PNG"; failures=$((failures + 1)) ;;
  esac

  edge=$(magick identify -format '%w %h' "$art")
  set -- $edge
  if [ "$1" -le 640 ] && [ "$2" -le 640 ]; then
    echo "ok       3000x2000 was capped to ${1}x${2}"
  else
    echo "FAIL     the written cover is ${1}x${2}, past the 640 cap"
    failures=$((failures + 1))
  fi
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures probe test(s) failed"
  exit 1
fi

echo "ok — probe tests passed"
