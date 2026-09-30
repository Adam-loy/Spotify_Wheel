// Pure helpers for the discovery features: search, and new music releases.
//
// MPRIS cannot do either -- it only reports and controls whatever a player is
// already doing. Spotify's own Web API could, but since February 2026 it
// refuses app owners without an active Premium subscription, and the endpoint
// that served new releases has been removed outright. So both features read
// from catalogues that answer without an account and without a key, and hand
// the choice back to Spotify as a deep link rather than pretending to control
// it. See README, "Search and new releases".

// Artwork is stored as the catalogue handed it over, unvetted. Nothing here
// decides what may be fetched: Model.js's art probe is the only gate, and it is
// applied to these URLs exactly as it is to the current cover's. Filtering a
// second time in a second file would only mean a third place to forget.

// --------------------------------------------------------------- URL vetting
//
// A raw space or control character in a URL has no legitimate meaning and
// serves only to make one thing parse as another. A catalogue response is no
// more trustworthy than album-art metadata, so the same rule is applied to the
// URLs inside it before they are stored.
function cleanUrl(value) {
  var url = String(value || "")
  if (!url || url.indexOf("https://") !== 0) return ""

  for (var i = 0; i < url.length; i++) {
    var code = url.charCodeAt(i)
    if (code <= 0x20 || code === 0x7f) return ""
  }

  return url
}

// ------------------------------------------------------------------ fetching
//
// One script for every catalogue call, with the finished URL as $1 so no query
// text ever reaches the command line as code. The host list is re-checked here
// rather than trusted from the caller, because this is the last point before a
// remote URL is fetched and something upstream is what chose it.
//
// Bounded the same way the cover probe is: no redirects, a size cap that is
// applied to the bytes on disk as well as to any declared length, and a
// timeout. The response is JSON, so it is also refused unless it looks like
// JSON, which keeps a captive-portal login page from being parsed as results.
function fetchScript() {
  return [
    'set -eu',
    'url="$1"',
    '',
    'case "$url" in',
    '  https://api.deezer.com/*|https://itunes.apple.com/*) ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
    'max=2000000',
    'tmp=$(mktemp) || exit 1',
    'trap \'rm -f "$tmp"\' EXIT',
    '',
    'curl -sf --proto "=https" --max-redirs 0 --max-filesize "$max" \\',
    '     --max-time 8 -o "$tmp" -- "$url" || exit 1',
    '',
    'size=$(wc -c < "$tmp") || exit 1',
    '[ "$size" -gt 0 ] && [ "$size" -le "$max" ] || exit 1',
    '',
    '# A proxy or captive portal answers with HTML, and JSON.parse would then',
    '# fail on a wall of markup. Looking at the first character turns that into',
    '# a clean empty result instead of an error in the panel. Leading whitespace',
    '# is skipped first: Apple\'s search answers with a blank line before the',
    '# JSON, and rejecting that would throw away every result it returns.',
    'first=$(head -c 64 "$tmp" | tr -d \'[:space:]\' | head -c 1)',
    'case "$first" in',
    '  \'{\'|\'[\') ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
    'cat -- "$tmp"'
  ].join('\n')
}

// ------------------------------------------------------------------- queries
//
// The query is percent-encoded here, before it reaches the script, so the shell
// only ever sees an already-encoded URL. Every value the catalogue understands
// is interpolated by us, never taken from the response and echoed back.
function encode(value) {
  return encodeURIComponent(String(value || ""))
}

function searchUrl(kind, query, limit) {
  var q = String(query || "").trim()
  if (!q) return null

  var count = Math.max(1, Math.min(50, Number(limit) || 20))
  var path = kind === "album" ? "search/album" : "search/track"
  return "https://api.deezer.com/" + path + "?q=" + encode(q) + "&limit=" + count
}

// iTunes sorts by release date, which is what makes this a "what came out
// recently" list rather than another popularity ranking. The genre is passed as
// a term, so a list of them is built from that catalogue.
function newReleasesUrl(query, limit) {
  var q = String(query || "").trim()
  if (!q) return null

  var count = Math.max(1, Math.min(50, Number(limit) || 20))
  return "https://itunes.apple.com/search?term=" + encode(q)
    + "&entity=album&sort=recent&limit=" + count
}

// -------------------------------------------------------------- normalising
//
// Both catalogues are reduced to one shape, so the results list is written once
// and the choice of source never reaches the UI. A record missing the fields
// that make a result usable is dropped rather than rendered as a blank row.

function text(value) {
  var out = String(value === null || value === undefined ? "" : value).trim()
  return out
}

function makeResult(kind, title, artist, album, artwork, extra) {
  var record = {
    kind: kind,
    title: text(title),
    artist: text(artist),
    album: text(album),
    artwork: cleanUrl(artwork)
  }

  if (extra) {
    for (var key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) record[key] = extra[key]
    }
  }

  // A row with no title and no artist is a caption, not something to search for.
  if (!record.title && !record.artist) return null
  return record
}

// iTunes hands back a 100px thumbnail whose size is a path segment. Ask for a
// larger one, and leave the URL alone if it is not the shape expected -- the
// original is still a working image.
function itunesArtwork(url) {
  var value = String(url || "")
  return value.replace(/\/\d+x\d+bb\.(jpg|png)$/, "/600x600bb.$1")
}

function parseDeezerTracks(raw) {
  var data = json(raw)
  if (!data || !data.data) return []

  var out = []
  for (var i = 0; i < data.data.length && out.length < 50; i++) {
    var item = data.data[i] || {}
    var album = item.album || {}

    var row = makeResult("track", item.title, item.artist && item.artist.name,
      album.title, album.cover_medium, {
        duration: Number(item.duration) || 0,
        rank: Number(item.rank) || 0
      })
    if (row) out.push(row)
  }

  return out
}

function parseDeezerAlbums(raw) {
  var data = json(raw)
  if (!data || !data.data) return []

  var out = []
  for (var i = 0; i < data.data.length && out.length < 50; i++) {
    var item = data.data[i] || {}

    var row = makeResult("album", item.title, item.artist && item.artist.name,
      item.title, item.cover_medium, {
        released: text(item.release_date),
        tracks: Number(item.nb_tracks) || 0
      })
    if (row) out.push(row)
  }

  return out
}

function parseItunesAlbums(raw) {
  var data = json(raw)
  if (!data || !data.results) return []

  var out = []
  for (var i = 0; i < data.results.length && out.length < 50; i++) {
    var item = data.results[i] || {}

    var row = makeResult("album", item.collectionName, item.artistName,
      item.collectionName, itunesArtwork(item.artworkUrl100), {
        released: itunesDate(item.releaseDate),
        tracks: Number(item.trackCount) || 0,
        genre: text(item.primaryGenreName)
      })
    if (row) out.push(row)
  }

  return out
}

// A catalogue date is either a full timestamp or a year, and the panel shows
// whatever precision it was given rather than inventing the rest.
function itunesDate(value) {
  var raw = text(value)
  if (!raw) return ""
  return raw.substring(0, 10)
}

// Apple's search answers `sort=recent`, which turns out to mean "recent,
// among the things that match" rather than "recent". Ask it for jazz and the
// top of the page is a 1956 compilation called Jazz, because that is the most
// relevant match and relevance outranks date. Ordering the answer afterwards is
// the only way to get a list that is actually newest-first, and dates that
// cannot be read go to the bottom rather than being guessed at.
function byNewest(rows) {
  return rows.slice().sort(function (a, b) {
    var left = text(a.released)
    var right = text(b.released)
    if (!left && !right) return 0
    if (!left) return 1
    if (!right) return -1
    if (left === right) return 0
    return left < right ? 1 : -1
  })
}

function json(raw) {
  try {
    var parsed = JSON.parse(String(raw || ""))
    return parsed && typeof parsed === "object" ? parsed : null
  } catch (e) {
    return null
  }
}

// -------------------------------------------------------------- handing over
//
// The one thing this widget cannot do without Premium is turn a catalogue
// result into a Spotify track id, so it does not pretend to. It hands Spotify a
// search URI scoped to the result, which is a documented part of the scheme
// Spotify registered with IANA, and the user lands on the real thing with one
// click from there.
//
// Field tags are quoted and percent-encoded, which is the form Spotify's own
// developer forum documents for a multi-word query. A title with no artist, an
// album, or a bare string all fall out of the same builder.

function spotifySearchUri(result) {
  if (!result) return null

  var field = result.kind === "album" ? "album" : "track"
  var title = text(result.title)
  var artist = text(result.artist)

  var parts = []
  if (title) parts.push(field + ':"' + title + '"')
  if (artist) parts.push('artist:"' + artist + '"')

  if (!parts.length) return null

  return "spotify:search:" + encodeURIComponent(parts.join(" "))
}

// The plain search the search box itself offers, for when there are no results
// to scope to.
function spotifyQueryUri(query) {
  var q = text(query)
  if (!q) return null
  return "spotify:search:" + encodeURIComponent(q)
}

// Nothing here touches Qt, so the whole file also loads under node and the
// tests in test/search-test.js exercise it directly. QML's .js import ignores
// this block.
if (typeof module !== "undefined") {
  module.exports = {
    cleanUrl: cleanUrl,
    fetchScript: fetchScript,
    searchUrl: searchUrl,
    newReleasesUrl: newReleasesUrl,
    itunesArtwork: itunesArtwork,
    parseDeezerTracks: parseDeezerTracks,
    parseDeezerAlbums: parseDeezerAlbums,
    parseItunesAlbums: parseItunesAlbums,
    byNewest: byNewest,
    spotifySearchUri: spotifySearchUri,
    spotifyQueryUri: spotifyQueryUri
  }
}
