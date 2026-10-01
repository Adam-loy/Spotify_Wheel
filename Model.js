// Pure helpers for the Spotify bar widget. Kept out of Panel.qml so the QML
// stays declarative and these stay trivially testable.

// Spotify's own MPRIS bus is org.mpris.MediaPlayer2.spotify, but the same
// widget should also drive the headless clients people run instead of the
// desktop app, so match on bus name, desktop entry, and identity.
function isSpotify(player) {
  if (!player) return false

  var dbusName = String(player.dbusName || "").toLowerCase()
  var desktopEntry = String(player.desktopEntry || "").toLowerCase()
  var identity = String(player.identity || "").toLowerCase()

  if (dbusName.indexOf("mediaplayer2.spotify") !== -1) return true
  if (desktopEntry === "spotify" || desktopEntry === "spotifyd" || desktopEntry === "spotify-player") return true
  return identity === "spotify" || identity === "spotifyd"
}

// A playing client wins over an idle one, so a paused leftover instance never
// hides the one actually making sound.
function findSpotify(players) {
  var list = players && players.length !== undefined ? players : []
  var idle = null

  for (var i = 0; i < list.length; i++) {
    var p = list[i]
    if (!isSpotify(p)) continue
    if (p.isPlaying) return p
    if (!idle) idle = p
  }

  return idle
}

function barLabel(player, showArtist) {
  if (!player) return ""

  var title = String(player.trackTitle || "")
  var artist = String(player.trackArtist || "")

  if (!title) return artist
  if (!showArtist || !artist) return title
  return title + "  ·  " + artist
}

function tooltipText(player) {
  if (!player) return "Spotify — not running"

  var label = barLabel(player, true)
  if (!label) return "Spotify"
  return (player.isPlaying ? "" : "Paused — ") + label
}

// MPRIS positions come through Quickshell as seconds.
function formatTime(seconds) {
  var total = Math.floor(Number(seconds) || 0)
  if (total < 0) total = 0

  var hours = Math.floor(total / 3600)
  var minutes = Math.floor((total % 3600) / 60)
  var secs = total % 60

  if (hours > 0) return hours + ":" + pad(minutes) + ":" + pad(secs)
  return minutes + ":" + pad(secs)
}

function pad(value) {
  return value < 10 ? "0" + value : String(value)
}

// ---------------------------------------------------------------- album art
//
// The panel wears the current cover as its background. Two numbers drive
// that: the cover's mean luminance, which sets how heavily the scrim has to
// cover it for text to stay readable, and its dominant colour, which tints
// the scrim so the panel reads as part of the artwork rather than a window
// sitting on top of it. Both come from one ImageMagick probe — see
// `artProbeScript` — and everything below is the parsing and the maths.

// Album art is metadata published by another process, so the whole of the
// probe treats it as hostile input: this decides what may be fetched at all,
// and `artProbeScript` bounds what happens to the bytes that come back.

// The only hosts whose images are fetched, matched on a label boundary so a
// registered lookalike like "evilscdn.co" is not taken for a subdomain.
//
// Search results carry artwork from the catalogue they were found in, so those
// hosts are here as well. This list is the whole of what Qt is ever allowed to
// fetch a remote image from -- search results are vetted by the same gate as
// the current cover, not by a second one of their own, so widening it is a
// deliberate act with a single blast radius.
var artHosts = ["scdn.co", "dzcdn.net", "mzstatic.com"]

// Where Spotify's window is put when the widget is being the player.
//
// A named special workspace, and specifically one of our own rather than the
// conventional "minimized", so that showing and hiding it can never disturb a
// scratchpad the user has bound to something of their own. Windows on a special
// workspace stay mapped and keep playing; they just cannot be landed on by
// accident.
var HIDDEN_WORKSPACE = "special:spotify"

function artHostAllowed(host) {
  var name = String(host || "").toLowerCase()

  for (var i = 0; i < artHosts.length; i++) {
    if (name === artHosts[i]) return true
    var suffix = "." + artHosts[i]
    if (name.length > suffix.length && name.slice(-suffix.length) === suffix) return true
  }

  return false
}

// A raw space or control character in a URL has no legitimate meaning and
// serves only to make one thing parse as another.
function artUnprintable(value) {
  for (var i = 0; i < value.length; i++) {
    var code = value.charCodeAt(i)
    if (code <= 0x20 || code === 0x7f) return true
  }
  return false
}

// A decoded path is held to the same rule minus the space, because a file on
// disk is perfectly entitled to one.
function artControlChars(value) {
  for (var i = 0; i < value.length; i++) {
    var code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

// What to hand the probe, or null when there is nothing worth probing.
function artProbeTarget(artUrl) {
  var url = String(artUrl || "")
  if (!url || artUnprintable(url)) return null

  if (url.indexOf("file://") === 0) {
    var path
    try {
      path = decodeURIComponent(url.substring(7))
    } catch (e) {
      return null
    }
    // A local absolute path only. file://host/path names another machine.
    if (path.indexOf("/") !== 0) return null
    if (artControlChars(path)) return null
    return path
  }

  if (url.indexOf("https://") !== 0) return null

  // The authority is everything before the first path, query or fragment.
  var authority = url.substring(8).split(/[/?#]/)[0]
  if (!authority) return null
  // Credentials and ports are never part of an album-art URL, and userinfo in
  // particular is the oldest way to make a URL read as a host it is not.
  if (authority.indexOf("@") !== -1 || authority.indexOf(":") !== -1) return null
  if (!artHostAllowed(authority.toLowerCase())) return null

  return url
}

// One shell script, run with the target as $1 so no metadata ever reaches the
// command line as code.
//
// Clearing the host check is the start of the argument and not the end of it,
// because everything after it is still attacker-shaped: the response body, its
// size, and whatever ImageMagick decides the bytes are. So the fetch does not
// follow redirects away from the host that was checked, the download is bounded
// twice, the format is named here from the magic bytes rather than guessed by
// the decoder, and the decode runs under explicit resource limits.
function artProbeScript() {
  return [
    'set -eu',
    'src="$1"',
    '',
    '# A cover is a few hundred kilobytes. Anything far past that is not one.',
    'max=8000000',
    '',
    'tmp=$(mktemp) || exit 1',
    'trap \'rm -f "$tmp"\' EXIT',
    '',
    'case "$src" in',
    '  https://*)',
    '    # No redirects. The host was checked before this ran, and following a',
    '    # redirect would move the fetch to one that was not.',
    '    curl -sf --proto "=https" --max-redirs 0 --max-filesize "$max" \\',
    '         --max-time 8 -o "$tmp" -- "$src" || exit 1',
    '    ;;',
    '  *)',
    '    [ -f "$src" ] || exit 1',
    '    [ "$(wc -c < "$src")" -le "$max" ] || exit 1',
    '    cp -- "$src" "$tmp" || exit 1',
    '    ;;',
    'esac',
    '',
    '# --max-filesize acts only on a declared Content-Length, so the size that',
    '# decides is the one on disk.',
    'size=$(wc -c < "$tmp") || exit 1',
    '[ "$size" -gt 0 ] && [ "$size" -le "$max" ] || exit 1',
    '',
    '# Name the format from the magic bytes instead of letting ImageMagick pick',
    '# it. Handing unidentified bytes to a decoder that dispatches on content is',
    '# how a cover URL turns into a delegate; these five raster formats cover',
    '# every cover a player publishes and none of them reach one.',
    'sig=$(od -An -v -tx1 -N16 "$tmp" | tr -d " \\n") || exit 1',
    'case "$sig" in',
    '  ffd8ff*) fmt=JPEG ;;',
    '  89504e470d0a1a0a*) fmt=PNG ;;',
    '  474946383961*|474946383761*) fmt=GIF ;;',
    '  424d*) fmt=BMP ;;',
    '  52494646????????57454250*) fmt=WEBP ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
    '# Bounds for the decode itself, because a small file can still declare an',
    '# enormous image. The width and height limits are the ones that refuse:',
    '# libpng checks them while reading IHDR, so an oversized cover is rejected',
    '# before a single pixel is allocated. The rest only bound the cost of what',
    '# gets past them -- in particular the area limit chooses where the pixel',
    '# cache lives rather than refusing anything, so it is no defence on its own.',
    '# No real cover comes close to 8000px; Spotify publishes 640.',
    'MAGICK_WIDTH_LIMIT=8KP',
    'MAGICK_HEIGHT_LIMIT=8KP',
    'MAGICK_AREA_LIMIT=128MP',
    'MAGICK_MEMORY_LIMIT=256MiB',
    'MAGICK_MAP_LIMIT=512MiB',
    'MAGICK_TIME_LIMIT=10',
    'MAGICK_THREAD_LIMIT=2',
    'export MAGICK_WIDTH_LIMIT MAGICK_HEIGHT_LIMIT MAGICK_AREA_LIMIT \\',
    '       MAGICK_MEMORY_LIMIT MAGICK_MAP_LIMIT MAGICK_TIME_LIMIT MAGICK_THREAD_LIMIT',
    '',
    'mean=$(magick "$fmt:$tmp[0]" -resize 1x1! -depth 8 -format "%[hex:p{0,0}]" info:) || exit 1',
    '',
    '# The panel shows the cover as well as measuring it, and a QML Image given',
    '# a raw art URL would repeat none of the checks above: Qt would fetch any',
    '# origin, follow redirects, and decode whatever format its plugins handle',
    '# -- SVG and PDF among them -- inside the shell process. So the cover it',
    '# displays is this one: re-encoded here from bytes that passed every check,',
    '# and capped at a size no cover needs, which bounds the decode too.',
    'dir="${XDG_CACHE_HOME:-$HOME/.cache}/Spotify_Wheel/covers"',
    'mkdir -p "$dir" || exit 1',
    'chmod 700 "$dir" 2>/dev/null || :',
    '',
    '# Named for the source so a track change is a new path, which is what lets',
    '# the panel cross-fade rather than reload the same file in place.',
    'stamp=$(printf %s "$src" | sha256sum | cut -c1-32) || exit 1',
    'art="$dir/$stamp.png"',
    '',
    'if [ ! -f "$art" ]; then',
    '  magick "$fmt:$tmp[0]" -resize "640x640>" -strip "PNG:$art.new" || exit 1',
    '  mv -f "$art.new" "$art" || exit 1',
    'fi',
    '',
    '# Keep the last handful. Every name here is hex, so the listing is safe to',
    '# read line by line.',
    'ls -1t "$dir"/*.png 2>/dev/null | tail -n +9 | while IFS= read -r stale; do',
    '  rm -f -- "$stale"',
    'done',
    '',
    'printf "MEAN %s\\n" "$mean"',
    'printf "ART %s\\n" "$art"',
    'echo HIST',
    'magick "$fmt:$tmp[0]" -resize 80x80 -depth 8 -colors 8 -format "%c" histogram:info:'
  ].join('\n')
}

// Search results need a thumbnail each, and running the single-cover probe once
// per row would mean a subprocess and a download per row. So this takes every
// URL at once and re-encodes the lot in one process.
//
// It holds to the same standard as `artProbeScript` in every respect that
// matters: the host is checked here as well as by the caller, redirects are
// refused, the download is bounded twice, the format is named from the magic
// bytes rather than inferred, and the decode runs under the same resource
// limits. Thumbnails are smaller, so they are decoded at 160px and the cap is
// tightened to match.
//
// One bad URL must not lose the others, so a failure is skipped and the loop
// carries on; each surviving row is reported by the index it was given, which is
// how the caller matches a path back to a result that may since have changed.
function artBatchScript() {
  return [
    'set -u',
    '',
    'dir="${XDG_CACHE_HOME:-$HOME/.cache}/Spotify_Wheel/thumbs"',
    'mkdir -p "$dir" || exit 1',
    'chmod 700 "$dir" 2>/dev/null || :',
    '',
    'max=2000000',
    'index=0',
    'for src in "$@"; do',
    '  index=$((index + 1))',
    '',
    '  # Checked here too, not only by the caller, because this is the last',
    '  # point before a remote URL is fetched and the list came out of a JSON',
    '  # body written by somebody else.',
    '  case "$src" in',
    '    https://*.scdn.co/*|https://*.dzcdn.net/*|https://*.mzstatic.com/*) ;;',
    '    *) continue ;;',
    '  esac',
    '',
    '  case "$src" in',
    '    *[[:space:]]*) continue ;;',
    '  esac',
    '',
    '  stamp=$(printf %s "$src" | sha256sum | cut -c1-32) || continue',
    '  out="$dir/$stamp.png"',
    '',
    '  if [ -f "$out" ]; then',
    '    printf "THUMB %s %s\\n" "$index" "$out"',
    '    continue',
    '  fi',
    '',
    '  tmp=$(mktemp) || continue',
    '  if ! curl -sf --proto "=https" --max-redirs 0 --max-filesize "$max" \\',
    '       --max-time 8 -o "$tmp" -- "$src"; then',
    '    rm -f -- "$tmp"',
    '    continue',
    '  fi',
    '',
    '  size=$(wc -c < "$tmp") 2>/dev/null || size=0',
    '  if [ "$size" -le 0 ] || [ "$size" -gt "$max" ]; then',
    '    rm -f -- "$tmp"',
    '    continue',
    '  fi',
    '',
    '  sig=$(od -An -v -tx1 -N16 "$tmp" 2>/dev/null | tr -d " \\n") || sig=""',
    '  case "$sig" in',
    '    ffd8ff*) fmt=JPEG ;;',
    '    89504e470d0a1a0a*) fmt=PNG ;;',
    '    474946383961*|474946383761*) fmt=GIF ;;',
    '    424d*) fmt=BMP ;;',
    '    52494646????????57454250*) fmt=WEBP ;;',
    '    *) rm -f -- "$tmp"; continue ;;',
    '  esac',
    '',
    '  if magick "$fmt:$tmp[0]" -resize "160x160>" -strip "PNG:$out.new" 2>/dev/null; then',
    '    mv -f "$out.new" "$out" 2>/dev/null || rm -f -- "$out.new"',
    '    printf "THUMB %s %s\\n" "$index" "$out"',
    '  else',
    '    rm -f -- "$out.new"',
    '  fi',
    '  rm -f -- "$tmp"',
    'done',
    '',
    '# Keep the most recent few. Every name here is hex, so the listing is safe',
    '# to read line by line.',
    'ls -1t "$dir"/*.png 2>/dev/null | tail -n +61 | while IFS= read -r stale; do',
    '  rm -f -- "$stale"',
    'done',
    '',
    'exit 0'
  ].join('\n')
}

// Turns the batch probe's stdout into { "<index>": path }.
function parseArtBatch(text) {
  var found = {}

  String(text || "").split("\n").forEach(function(line) {
    var match = /^THUMB\s+(\d+)\s+(\S.*)$/.exec(line)
    if (!match) return

    // A path is only ever the one the script just wrote, under the directory
    // it just made; nothing from the catalogue reaches the panel.
    found[match[1]] = match[2]
  })

  return found
}

// ------------------------------------------------------- desktop operations
//
// The two things this widget does to Spotify itself, both as generated scripts
// so that nothing reaches a command line as code and every path is a literal.

// Starts Spotify and then gets its window out of the way, so the bar widget
// stays the whole interface and the app is never something you have to look at.
//
// The two halves have to be one script because of the timing. At the moment
// Spotify is launched there is no window to move, and it appears a second or
// two later, so a caller that launched and then immediately asked for the
// window to be hidden would find nothing and give up. Polling for a short
// while is what makes "start it hidden" a thing that actually works.
//
// `launch` is what the widget's own Launch button and the start-on-login
// setting use. Passing false hides a window that is already open, which is what
// the Minimise button wants.
function spotifyBackgroundScript(launch) {
  return [
    'set -u',
    '',
    'command -v hyprctl >/dev/null 2>&1 || exit 1',
    'command -v jq >/dev/null 2>&1 || exit 1',
    '',
    (launch
      ? [
        '# Launched through Omarchy so the desktop entry, and not a bare binary,',
        '# is what decides how Spotify starts. `setsid` detaches it from this',
        '# script: otherwise killing this script to tidy up would take the music',
        '# down with it.',
        'setsid -f omarchy launch spotify >/dev/null 2>&1 || exit 1'
      ].join('\n')
      : '# Already running; only the window needs moving.'),
    '',
    '# The window goes to a special workspace. That is a scratchpad you cannot',
    '# land on by accident: it is not in the workspace list, it does not change',
    '# what the user is looking at, and the client stays mapped, so playback is',
    '# untouched. `follow = false` is what keeps the move from yanking the user',
    '# onto the window we are hiding.',
    '#',
    '# Bounded at 30s. A cold start on a slow disk is a few seconds, and a login',
    '# where Spotify never appears should not leave a spinner in the panel.',
    'i=0',
    'while [ "$i" -lt 60 ]; do',
    '  addr=$(hyprctl clients -j 2>/dev/null | jq -r \'',
    '    [ .[]',
    '      | select(((.class // "") | ascii_downcase | test("spotify"))',
    '           or ((.title // "") | ascii_downcase | test("spotify")))',
    '      | select(((.workspace // "") | tostring | startswith("special")) | not)',
    '    ][0].address // empty',
    '\')',
    '  if [ -n "${addr:-}" ]; then',
    '    break',
    '  fi',
    '  i=$((i + 1))',
    '  sleep 0.5',
    'done',
    '',
    'if [ -z "${addr:-}" ]; then',
    '  # Launched but never appeared. Not worth an error: the panel already has an',
    '  # idle state for Spotify not running, and it is showing it.',
    '  exit 0',
    'fi',
    '',
    '# The address goes into a Lua string literal, so it is checked against what',
    '# Hyprland actually emits rather than trusted. Nothing else is interpolated.',
    'case "$addr" in',
    '  0x*[0-9a-fA-F]*) ;;',
    '  *) echo "refusing a window address that is not hex: $addr" >&2; exit 1 ;;',
    'esac',
    'case "$addr" in',
    '  *[!0-9a-fA-Fx]*) echo "refusing a window address with odd characters" >&2; exit 1 ;;',
    'esac',
    '',
    '# Hyprland 0.55 moved dispatchers behind a Lua layer, and this needs the',
    '# current form: `hl.dsp.window.move` with the window given as an',
    '# `address:` selector, dispatched through `hyprctl dispatch` (which wraps it',
    '# in `hl.dispatch` for you -- wrapping it again is an error). The old',
    '# string form, `hyprctl dispatch movetoworkspace special:...`, is a no-op on',
    '# 0.56 and, worse, used to fail silently.',
    'hyprctl dispatch "hl.dsp.window.move({ window = \\"address:$addr\\", workspace = \\"' + HIDDEN_WORKSPACE + '\\", follow = false })" >/dev/null 2>&1 || exit 1',
    '',
    '# Confirm it actually moved. A dispatcher that does nothing still reports',
    '# success, so believing the exit code here would mean the widget claims to',
    '# have hidden a window that is sitting in plain view.',
    'i=0',
    'while [ "$i" -lt 20 ]; do',
    '  ws=$(hyprctl clients -j 2>/dev/null | jq -r --arg a "$addr" \'',
    '    [ .[] | select(((.address // "") | ascii_downcase) == ($a | ascii_downcase))',
    '         | (.workspace.name // "") ][0] // empty',
    '\')',
    '  case "$ws" in',
    '    special:*) exit 0 ;;',
    '  esac',
    '  i=$((i + 1))',
    '  sleep 0.25',
    'done',
    '',
    'echo "Spotify is still on workspace ${ws:-unknown} after asking for ' + HIDDEN_WORKSPACE + '" >&2',
    'exit 1'
  ].join('\n')
}

// The way back, for the widget's "Show app" button: take the window off the
// special workspace and onto whatever the user is looking at, following it so
// it comes up. This is the only thing in the widget that puts Spotify on screen.
function spotifyShowScript() {
  return [
    'set -u',
    '',
    'command -v hyprctl >/dev/null 2>&1 || exit 1',
    'command -v jq >/dev/null 2>&1 || exit 1',
    '',
    'addr=$(hyprctl clients -j 2>/dev/null | jq -r \'',
    '  [ .[]',
    '    | select(((.class // "") | ascii_downcase | test("spotify"))',
    '         or ((.title // "") | ascii_downcase | test("spotify")))',
    '  ][0].address // empty',
    '\')',
    'if [ -z "${addr:-}" ]; then exit 0; fi',
    '',
    'case "$addr" in',
    '  0x*[0-9a-fA-F]*) ;;',
    '  *) echo "refusing a window address that is not hex: $addr" >&2; exit 1 ;;',
    'esac',
    'case "$addr" in',
    '  *[!0-9a-fA-Fx]*) echo "refusing a window address with odd characters" >&2; exit 1 ;;',
    'esac',
    '',
    'ws=$(hyprctl activeworkspace -j 2>/dev/null | jq -r \'.id // empty\')',
    'case "${ws:-}" in',
    '  ""|*[!0-9]*) echo "could not read the current workspace" >&2; exit 1 ;;',
    'esac',
    '',
    'hyprctl dispatch "hl.dsp.window.move({ window = \\"address:$addr\\", workspace = ' + '${ws}' + ', follow = true })" >/dev/null 2>&1 || exit 1',
    'exit 0'
  ].join('\n')
}

// Turns the probe's stdout into { mean, dominant, luma } or null.
function parseArtProbe(text) {
  var lines = String(text || "").split("\n")
  var mean = null
  var file = ""
  var swatches = []

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]

    var meanMatch = /^MEAN\s+([0-9A-Fa-f]{6})/.exec(line)
    if (meanMatch) {
      mean = "#" + meanMatch[1].toLowerCase()
      continue
    }

    // The normalised copy the panel is allowed to display. Only ever a path
    // the script just wrote, under the cache directory it just made.
    var artMatch = /^ART\s+(\S.*)$/.exec(line)
    if (artMatch) {
      file = artMatch[1]
      continue
    }

    // e.g. "   2581: (214,212,206) #D6D4CE srgb(214,212,206)"
    var histMatch = /^\s*(\d+):\s*\([^)]*\)\s*#([0-9A-Fa-f]{6})/.exec(line)
    if (histMatch) {
      swatches.push({ count: Number(histMatch[1]), hex: "#" + histMatch[2].toLowerCase() })
    }
  }

  var dominant = pickDominant(swatches)
  if (!mean && !dominant) return null
  if (!mean) mean = dominant
  if (!dominant) dominant = mean

  return { mean: mean, dominant: dominant, luma: luminance(mean), file: file }
}

// A path turned into a URL a QML Image will accept, with every segment encoded
// so a space or a "#" in it cannot end the path early.
function fileUrl(path) {
  var value = String(path || "")
  if (!value) return ""
  return "file://" + value.split("/").map(encodeURIComponent).join("/")
}

// The colour a person would name if asked what colour the cover is: usually
// not the most common one, because backgrounds are grey and skies are large.
// Weight area sub-linearly, reward saturation hard, and prefer mid tones —
// then fall back to sheer area when the cover really is monochrome.
function pickDominant(swatches) {
  if (!swatches || !swatches.length) return null

  var best = null
  var bestScore = 0
  var biggest = null

  for (var i = 0; i < swatches.length; i++) {
    var swatch = swatches[i]
    if (!biggest || swatch.count > biggest.count) biggest = swatch

    var hsl = toHsl(swatch.hex)
    if (hsl.l < 0.10 || hsl.l > 0.94) continue

    // Peaks at l = 0.5 and falls off towards either end.
    var midness = 1 - Math.abs(hsl.l - 0.5) * 1.6
    if (midness < 0.1) midness = 0.1

    var score = Math.sqrt(swatch.count) * Math.pow(hsl.s, 1.4) * midness
    if (score > bestScore) {
      bestScore = score
      best = swatch
    }
  }

  // A washed-out cover scores near zero everywhere; area is the better answer.
  if (!best || bestScore < 0.35) return biggest ? biggest.hex : null
  return best.hex
}

// How opaque the scrim over the cover has to be. `intensity` is the user's
// 0-100 "how much cover shows through"; the luminance term is the adaptive
// half — a bright cover needs more covering than a dark one to hold the same
// contrast under light theme text.
function scrimAlpha(luma, intensity) {
  var showing = clamp(Number(intensity), 0, 100) / 100
  var base = 1 - 0.72 * showing
  var lift = Math.max(0, clamp(Number(luma), 0, 1) - 0.30) * 0.45
  return clamp(base + lift, 0.18, 0.97)
}

// Bright covers also get pulled down at the source, so the blur underneath
// the scrim is not a wall of white.
function artBrightness(luma) {
  return -clamp(Math.max(0, clamp(Number(luma), 0, 1) - 0.25) * 0.55, 0, 0.42)
}

// Nudge a colour's lightness until it clears `target` against the panel, so
// an accent taken from a near-black cover is still visible as an accent.
function ensureContrast(hex, target) {
  var hsl = toHsl(hex)
  var want = clamp(Number(target), 0, 1)
  if (hsl.l >= want) return normalizeHex(hex)

  // Saturated colours can afford to stay a little darker than grey ones.
  var lifted = want + hsl.s * 0.05
  return fromHsl(hsl.h, Math.max(hsl.s, 0.25), clamp(lifted, 0, 0.92))
}

// Rec. 709 luminance on gamma-encoded values. Close enough for deciding how
// dark to make a scrim, and far cheaper than linearising first.
function luminance(hex) {
  var rgb = toRgb(hex)
  if (!rgb) return 0
  return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255
}

function toRgb(hex) {
  var match = /^#?([0-9A-Fa-f]{6})$/.exec(String(hex || "").trim())
  if (!match) return null

  var value = parseInt(match[1], 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

function normalizeHex(hex) {
  var rgb = toRgb(hex)
  if (!rgb) return "#000000"
  return "#" + hexPair(rgb.r) + hexPair(rgb.g) + hexPair(rgb.b)
}

function hexPair(value) {
  var out = Math.round(clamp(value, 0, 255)).toString(16)
  return out.length < 2 ? "0" + out : out
}

function toHsl(hex) {
  var rgb = toRgb(hex)
  if (!rgb) return { h: 0, s: 0, l: 0 }

  var r = rgb.r / 255
  var g = rgb.g / 255
  var b = rgb.b / 255
  var max = Math.max(r, g, b)
  var min = Math.min(r, g, b)
  var l = (max + min) / 2

  if (max === min) return { h: 0, s: 0, l: l }

  var d = max - min
  var s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  var h = 0

  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6

  return { h: h, s: s, l: l }
}

function fromHsl(h, s, l) {
  if (s <= 0) {
    var grey = Math.round(clamp(l, 0, 1) * 255)
    return "#" + hexPair(grey) + hexPair(grey) + hexPair(grey)
  }

  var q = l < 0.5 ? l * (1 + s) : l + s - l * s
  var p = 2 * l - q

  return "#" + hexPair(hueToByte(p, q, h + 1 / 3))
    + hexPair(hueToByte(p, q, h))
    + hexPair(hueToByte(p, q, h - 1 / 3))
}

function hueToByte(p, q, t) {
  if (t < 0) t += 1
  if (t > 1) t -= 1

  var value = p
  if (t < 1 / 6) value = p + (q - p) * 6 * t
  else if (t < 1 / 2) value = q
  else if (t < 2 / 3) value = p + (q - p) * (2 / 3 - t) * 6

  return value * 255
}

function clamp(value, low, high) {
  var number = Number(value)
  if (!isFinite(number)) return low
  return number < low ? low : number > high ? high : number
}

// Nothing here touches Qt, so the whole file also loads under node and the
// tests in test/model-test.js exercise it directly. QML's .js import ignores
// this block.
if (typeof module !== "undefined") {
  module.exports = {
    isSpotify: isSpotify,
    findSpotify: findSpotify,
    barLabel: barLabel,
    tooltipText: tooltipText,
    formatTime: formatTime,
    artHostAllowed: artHostAllowed,
    artProbeTarget: artProbeTarget,
    artProbeScript: artProbeScript,
    artBatchScript: artBatchScript,
    parseArtBatch: parseArtBatch,
    spotifyBackgroundScript: spotifyBackgroundScript,
    spotifyShowScript: spotifyShowScript,
    hiddenWorkspace: HIDDEN_WORKSPACE,
    parseArtProbe: parseArtProbe,
    fileUrl: fileUrl,
    pickDominant: pickDominant,
    scrimAlpha: scrimAlpha,
    artBrightness: artBrightness,
    ensureContrast: ensureContrast,
    luminance: luminance,
    toHsl: toHsl,
    fromHsl: fromHsl,
    normalizeHex: normalizeHex
  }
}
