// Tests for everything the widget knows that is not painting. Model.js has no
// Qt in it, so player matching, the label, and the whole album-colour pipeline
// run here: `node test/model-test.js`.

const assert = require("assert")
const M = require("../Model.js")

// ------------------------------------------------------------ player matching
{
  const desktop = { dbusName: "org.mpris.MediaPlayer2.spotify", identity: "Spotify" }
  const daemon = { dbusName: "org.mpris.MediaPlayer2.spotifyd.instance7", identity: "spotifyd" }
  const tui = { dbusName: "org.mpris.MediaPlayer2.spotify_player", desktopEntry: "spotify-player" }
  const firefox = { dbusName: "org.mpris.MediaPlayer2.firefox.instance_1_2", identity: "Mozilla Firefox" }
  // Not Spotify, but its bus name contains the word.
  const decoy = { dbusName: "org.mpris.MediaPlayer2.notspotifyatall", identity: "Rhythmbox" }

  assert.ok(M.isSpotify(desktop))
  assert.ok(M.isSpotify(daemon))
  assert.ok(M.isSpotify(tui))
  assert.ok(!M.isSpotify(firefox))
  assert.ok(!M.isSpotify(decoy))
  assert.ok(!M.isSpotify(null))

  // A player that is actually making sound wins over one that is merely open,
  // so a forgotten paused instance never hides the live one.
  const paused = Object.assign({ isPlaying: false }, desktop)
  const playing = Object.assign({ isPlaying: true }, daemon)
  assert.strictEqual(M.findSpotify([paused, playing]), playing)
  assert.strictEqual(M.findSpotify([playing, paused]), playing)
  assert.strictEqual(M.findSpotify([paused]), paused)
  assert.strictEqual(M.findSpotify([firefox]), null)
  assert.strictEqual(M.findSpotify([]), null)
  assert.strictEqual(M.findSpotify(undefined), null)
}

// -------------------------------------------------------------- the bar label
{
  const player = { trackTitle: "Instant Crush", trackArtist: "Daft Punk", isPlaying: true }
  assert.strictEqual(M.barLabel(player, true), "Instant Crush  ·  Daft Punk")
  assert.strictEqual(M.barLabel(player, false), "Instant Crush")
  assert.strictEqual(M.barLabel({ trackTitle: "", trackArtist: "Daft Punk" }, true), "Daft Punk")
  assert.strictEqual(M.barLabel({ trackTitle: "Solo", trackArtist: "" }, true), "Solo")
  assert.strictEqual(M.barLabel(null, true), "")

  assert.ok(M.tooltipText(player).indexOf("Instant Crush") !== -1)
  assert.ok(M.tooltipText(Object.assign({}, player, { isPlaying: false })).indexOf("Paused") === 0)
  assert.ok(M.tooltipText(null).indexOf("not running") !== -1)
}

// ------------------------------------------------------------------- run time
{
  assert.strictEqual(M.formatTime(0), "0:00")
  assert.strictEqual(M.formatTime(9), "0:09")
  assert.strictEqual(M.formatTime(274.52), "4:34")
  assert.strictEqual(M.formatTime(3600), "1:00:00")
  assert.strictEqual(M.formatTime(3725), "1:02:05")
  // Never a negative clock, whatever the player reports.
  assert.strictEqual(M.formatTime(-5), "0:00")
  assert.strictEqual(M.formatTime(undefined), "0:00")
}

// ------------------------------------------------- what may be handed to sh(1)
{
  const art = "https://i.scdn.co/image/ab67616d0000b273d1ec82bc061a90006584aa9b"
  assert.strictEqual(M.artProbeTarget(art), art)
  assert.strictEqual(M.artProbeTarget("https://scdn.co/image/abc"), "https://scdn.co/image/abc")
  assert.strictEqual(M.artProbeTarget("https://open.scdn.co/image/abc"), "https://open.scdn.co/image/abc")
  // Case in the host is not a bypass and not a rejection.
  assert.ok(M.artProbeTarget("https://I.SCDN.CO/image/abc"))
  assert.strictEqual(M.artProbeTarget("file:///home/mich/cover.png"), "/home/mich/cover.png")
  // A file on disk may legitimately have a space in its name.
  assert.strictEqual(M.artProbeTarget("file:///home/mich/My%20Art.png"), "/home/mich/My Art.png")

  // The host is matched on a label boundary. An earlier version used a bare
  // prefix pattern, which let anyone who registered "evilscdn.co" point the
  // probe at their own server.
  assert.ok(M.artHostAllowed("scdn.co"))
  assert.ok(M.artHostAllowed("i.scdn.co"))
  assert.ok(!M.artHostAllowed("evilscdn.co"))
  assert.ok(!M.artHostAllowed("scdn.co.evil.test"))
  assert.ok(!M.artHostAllowed(".scdn.co"))

  // Art URLs are metadata from another process, so everything that is not
  // plainly one of the two shapes a player publishes is refused, not probed.
  const refused = [
    "https://evilscdn.co/image/x",            // lookalike, no label boundary
    "https://myscdn.co/image/x",              // same
    "https://i.scdn.co.attacker.test/x",      // the real host as a prefix
    "https://i.scdn.co@evil.test/x",          // userinfo, not a host
    "https://i.scdn.co:8443/x",               // a port is never part of one
    "https://evil.test/#https://i.scdn.co/",  // the allowed host in a fragment
    "https://evil.test/?u=https://i.scdn.co", // and in a query
    "http://i.scdn.co/image/x",               // plaintext
    "HTTPS://i.scdn.co/image/x",              // scheme must be exact
    "https:///image/x",                       // no host at all
    "file://remote/share/art.png",            // names another machine
    "file://../../etc/passwd",                // not an absolute local path
    "https://i.scdn.co/image/a b",            // a raw space in a URL
    "file:///home/mich/a%00b.png",            // a control character in a path
    "$(rm -rf ~)",
    "; rm -rf ~",
    "`id`",
    "|| curl evil.test",
    "", null, undefined
  ]
  refused.forEach(function (value) {
    assert.strictEqual(M.artProbeTarget(value), null, JSON.stringify(value))
  })
}

// ------------------------------------------- and what the script does with it
{
  const script = M.artProbeScript()

  // The target arrives as an argument, never spliced into the script.
  assert.ok(script.indexOf('"$1"') !== -1)

  // Clearing the host check is worth nothing if the fetch then follows a
  // redirect somewhere else, so it does not follow one.
  assert.ok(!/curl[^\n]*\s-[A-Za-z]*L/.test(script), "curl must not follow redirects")
  assert.ok(script.indexOf("--max-redirs 0") !== -1)
  assert.ok(script.indexOf('--proto "=https"') !== -1)

  // The download is bounded by what the server declares and again by what
  // actually landed, because the first bound needs a Content-Length.
  assert.ok(script.indexOf("--max-filesize") !== -1)
  assert.ok(/wc -c < "\$tmp"/.test(script))

  // The format is decided from the magic bytes here, so ImageMagick is never
  // the thing choosing a decoder for attacker-supplied content.
  assert.ok(script.indexOf("ffd8ff") !== -1)
  assert.ok(script.indexOf("89504e470d0a1a0a") !== -1)
  assert.ok(/magick "\$fmt:\$tmp\[0\]"/.test(script))

  // The cover the panel displays is written here from bytes that passed every
  // check above, capped at a size no cover needs, which bounds Qt's decode of
  // it as well.
  assert.ok(/-resize "640x640>"/.test(script))
  assert.ok(script.indexOf('printf "ART %s') !== -1)
  assert.ok(script.indexOf("XDG_CACHE_HOME") !== -1)

  // And the decode is bounded, since a tiny file can declare a huge image.
  // The width and height caps are the ones that refuse — the area limit only
  // decides where the pixel cache lives, so it is not a defence by itself.
  // test/probe-test.sh is what shows this actually holding.
  assert.ok(script.indexOf("MAGICK_WIDTH_LIMIT=8KP") !== -1)
  assert.ok(script.indexOf("MAGICK_HEIGHT_LIMIT=8KP") !== -1)
  ;["MAGICK_AREA_LIMIT", "MAGICK_MEMORY_LIMIT", "MAGICK_MAP_LIMIT",
    "MAGICK_TIME_LIMIT", "MAGICK_THREAD_LIMIT"].forEach(function (limit) {
    assert.ok(script.indexOf(limit + "=") !== -1, limit)
  })
}

// ------------------------------------- nothing else may load the art URL
{
  // The reported defect: the probe was hardened while the two QML Image
  // elements still took the raw MPRIS URL, so the displayed cover skipped
  // every check the probe made. Qt would have fetched any origin, followed
  // redirects, and decoded whatever its image plugins handle -- an Omarchy
  // install ships the SVG and PDF ones -- inside the shell process.
  //
  // Everything shown now comes from the file the probe wrote, so this asserts
  // the property directly against the QML rather than trusting it to stay so.
  const fs = require("fs")
  const panel = fs.readFileSync(require("path").join(__dirname, "..", "Panel.qml"), "utf8")

  const loaders = panel
    .split("\n")
    .map(function (line, index) { return { line: line.trim(), number: index + 1 } })
    .filter(function (entry) { return /^source\s*:/.test(entry.line) })

  assert.ok(loaders.length >= 2, "expected the panel to have image sources to check")

  // No source of any kind may name the raw URL. This is the invariant that
  // was broken; `source: artSource` naming a sibling item is fine, an art URL
  // is not.
  loaders.forEach(function (entry) {
    assert.ok(
      !/\bartUrl\b/.test(entry.line),
      "Panel.qml:" + entry.number + " loads the raw art URL: " + entry.line,
    )
  })

  // And the covers that are displayed come from the probed file, both of them:
  // the panel's thumbnail and the blurred backdrop.
  const probed = loaders.filter(function (entry) { return /artSourceUrl/.test(entry.line) })
  assert.strictEqual(probed.length, 2, "expected exactly two loads of the probed cover")
}

// ------------------------------------------------------ the file it hands over
{
  const probe = M.parseArtProbe([
    "MEAN 102030",
    "ART /home/mich/.cache/Spotify_Wheel/covers/abc123.png",
    "HIST",
    "          2581: (16,32,48) #102030 srgb(16,32,48)"
  ].join("\n"))
  assert.strictEqual(probe.file, "/home/mich/.cache/Spotify_Wheel/covers/abc123.png")

  // Output without an ART line still parses; there is simply nothing to show.
  const colourOnly = M.parseArtProbe("MEAN 102030\nHIST\n  10: (16,32,48) #102030 srgb(16,32,48)")
  assert.strictEqual(colourOnly.file, "")

  // A path becomes a URL with every segment encoded, so a space or a "#" in it
  // cannot end the path early.
  assert.strictEqual(M.fileUrl("/home/mich/cover.png"), "file:///home/mich/cover.png")
  assert.strictEqual(M.fileUrl("/home/my art/a b.png"), "file:///home/my%20art/a%20b.png")
  assert.strictEqual(M.fileUrl("/home/a#b/c.png"), "file:///home/a%23b/c.png")
  assert.strictEqual(M.fileUrl(""), "")
  assert.strictEqual(M.fileUrl(null), "")
}

// --------------------------------------------------------- reading the artwork
{
  // Real output, from Random Access Memories (Drumless Edition) — a cover that
  // is almost entirely pale beige.
  const beige = [
    "MEAN D2CFC8",
    "HIST",
    "           233: (185,180,169) #B9B4A9 srgb(185,180,169)",
    "          2581: (214,212,206) #D6D4CE srgb(214,212,206)",
    "          2531: (216,214,209) #D8D6D1 srgb(216,214,209)",
    "           167: (217,214,207) #D9D6CF srgb(217,214,207)"
  ].join("\n")

  const probe = M.parseArtProbe(beige)
  assert.strictEqual(probe.mean, "#d2cfc8")
  // Nothing on this cover is saturated, so area decides.
  assert.strictEqual(probe.dominant, "#d6d4ce")
  assert.ok(probe.luma > 0.8)

  assert.strictEqual(M.parseArtProbe(""), null)
  assert.strictEqual(M.parseArtProbe("magick: unable to open image"), null)
  assert.strictEqual(M.parseArtProbe(null), null)

  // A dark cover with one saturated area: the colour a person would name is
  // the green, not the near-black that covers most of the sleeve.
  const dark = M.pickDominant([
    { count: 4800, hex: "#0d0d12" },
    { count: 900, hex: "#1db954" },
    { count: 600, hex: "#141820" }
  ])
  assert.strictEqual(dark, "#1db954")

  // Mid-tones beat both ends, so neither the black bar nor the white text on
  // a sleeve is mistaken for its colour.
  assert.strictEqual(M.pickDominant([
    { count: 2000, hex: "#000000" },
    { count: 2000, hex: "#ffffff" },
    { count: 800, hex: "#b2313a" }
  ]), "#b2313a")

  assert.strictEqual(M.pickDominant([]), null)
  assert.strictEqual(M.pickDominant(null), null)
}

// ------------------------------------------------------------ the adaptive bit
{
  // The point of the whole feature: a brighter cover is covered more heavily,
  // so the panel's background lands in the same band whatever is playing.
  const dark = M.scrimAlpha(0.15, 55)
  const mid = M.scrimAlpha(0.47, 55)
  const bright = M.scrimAlpha(0.95, 55)
  assert.ok(dark < mid && mid < bright, [dark, mid, bright].join(" "))

  // More cover showing means less scrim, at every brightness.
  assert.ok(M.scrimAlpha(0.5, 90) < M.scrimAlpha(0.5, 55))
  assert.ok(M.scrimAlpha(0.5, 55) < M.scrimAlpha(0.5, 10))

  // Always a usable alpha, including from settings that make no sense.
  ;[0, 55, 100, -40, 900, NaN, undefined, "55"].forEach(function (intensity) {
    [0, 0.5, 1, -1, 2, NaN].forEach(function (luma) {
      const a = M.scrimAlpha(luma, intensity)
      assert.ok(a >= 0.18 && a <= 0.97, intensity + "/" + luma + " -> " + a)
    })
  })

  // Bright covers are also pulled down at the source; dark ones are left alone.
  assert.strictEqual(M.artBrightness(0.1), -0)
  assert.ok(M.artBrightness(0.9) < -0.3)
  assert.ok(M.artBrightness(1) >= -0.42)
}

// ------------------------------------------------------------- accent contrast
{
  // A near-black cover still has to yield a visible accent.
  const lifted = M.ensureContrast("#101a12", 0.48)
  assert.ok(M.toHsl(lifted).l >= 0.48, lifted)

  // One that is already bright enough is left exactly as it is.
  assert.strictEqual(M.ensureContrast("#1DB954", 0.30), "#1db954")

  // Lifting keeps the hue — an accent taken from a red cover stays red.
  const red = M.ensureContrast("#2a0508", 0.48)
  const hue = M.toHsl(red).h
  assert.ok(hue < 0.05 || hue > 0.95, red + " hue " + hue)

  assert.strictEqual(M.normalizeHex("#ABCDEF"), "#abcdef")
  assert.strictEqual(M.normalizeHex("not a colour"), "#000000")
  assert.strictEqual(M.luminance("#000000"), 0)
  // The Rec. 709 weights are floats, so white lands a hair under one.
  assert.ok(Math.abs(M.luminance("#ffffff") - 1) < 1e-9)
  assert.ok(M.luminance("#00ff00") > M.luminance("#0000ff"))

  // hsl round trip, since the accent path leans on it.
  ;["#1db954", "#b2313a", "#7f7f7f", "#ffffff", "#000000"].forEach(function (hex) {
    const hsl = M.toHsl(hex)
    const back = M.fromHsl(hsl.h, hsl.s, hsl.l)
    const a = parseInt(hex.slice(1), 16)
    const b = parseInt(back.slice(1), 16)
    for (let shift = 0; shift <= 16; shift += 8) {
      assert.ok(Math.abs(((a >> shift) & 255) - ((b >> shift) & 255)) <= 1, hex + " -> " + back)
    }
  })
}

console.log("ok — model tests passed")
