import QtQuick
import Quickshell
import Quickshell.Io
import "../Model.js" as Model
import "../Search.js" as Search

// A harness for the two logic files under QML's own JavaScript engine, which is
// not Node's: no `module`, a different set of built-ins, and a different idea of
// what a missing property does. Everything that decides what the panel shows or
// fetches runs here so that a construct Node accepts and QML does not is caught
// before the widget is ever in the bar.
//
//   qs -p qml/harness.qml -- .

ShellRoot {
  id: shell

  property int failures: 0
  property int checks: 0
  property string stage: "start"

  function check(label, actual, expected) {
    checks++
    if (actual !== expected) {
      failures++
      console.warn("FAIL  " + label + "\n        got      " + actual + "\n        expected " + expected)
    }
  }

  Component.onCompleted: run()

  function run() {
    stage = "urls"
    check("search url", Search.searchUrl("track", "daft punk", 5),
      "https://api.deezer.com/search/track?q=daft%20punk&limit=5")
    check("album url", Search.searchUrl("album", "x", 5),
      "https://api.deezer.com/search/album?q=x&limit=5")
    check("empty query", String(Search.searchUrl("track", "  ", 5)), "null")
    check("releases url has sort", String(Search.newReleasesUrl("jazz", 3).indexOf("sort=recent") !== -1), "true")

    stage = "vetting"
    check("host allowed", Model.artHostAllowed("i.scdn.co"), true)
    check("dzcdn allowed", Model.artHostAllowed("cdn-images.dzcdn.net"), true)
    check("mzstatic allowed", Model.artHostAllowed("is1-ssl.mzstatic.com"), true)
    check("lookalike refused", Model.artHostAllowed("evilscdn.co"), false)
    check("suffix lookalike refused", Model.artHostAllowed("dzcdn.net.evil.com"), false)
    check("probe target ok", String(Model.artProbeTarget("https://cdn-images.dzcdn.net/a/b.jpg")), "https://cdn-images.dzcdn.net/a/b.jpg")
    check("probe target refused", String(Model.artProbeTarget("https://evil.example.com/a.jpg")), "null")

    stage = "uri"
    check("track uri", Search.spotifySearchUri({ kind: "track", title: "Get Lucky", artist: "Daft Punk" }),
      "spotify:search:track%3A%22Get%20Lucky%22%20artist%3A%22Daft%20Punk%22")
    check("empty result", String(Search.spotifySearchUri({ kind: "track" })), "null")
    check("file url", Model.fileUrl("/tmp/a b.png"), "file:///tmp/a%20b.png")

    stage = "parsing"
    var tracks = Search.parseDeezerTracks('{"data":[{"title":"T","artist":{"name":"A"},"album":{"title":"Al","cover_medium":"https://cdn-images.dzcdn.net/c.jpg"},"duration":10}]}')
    check("track count", tracks.length, 1)
    check("track title", tracks[0].title, "T")
    check("track art kept", tracks[0].artwork, "https://cdn-images.dzcdn.net/c.jpg")
    check("bad json", Search.parseDeezerTracks("<html>").length, 0)
    check("empty obj", Search.parseItunesAlbums("{}").length, 0)

    stage = "art batch"
    var thumbs = Model.parseArtBatch("THUMB 1 /tmp/a.png\nTHUMB 4 /tmp/d.png\njunk\n")
    check("thumb 1", String(thumbs["1"]), "/tmp/a.png")
    check("thumb 4", String(thumbs["4"]), "/tmp/d.png")
    check("junk ignored", String(thumbs["junk"]), "undefined")

    stage = "ops"
    check("human bytes", Model.humanBytes(15 * 1024 * 1024), "15 MB")
    check("parse clear", JSON.stringify(Model.parseCacheClear("FREED 1024\nDIRS 2")), '{"freed":1024,"dirs":2}')

    stage = "live"
    live()
  }

  // A real request, through the real generated script, to prove the shell
  // quoting and the JSON both survive contact with a live catalogue.
  Process {
    id: probe
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        shell.stage = "live-done"
        var rows = Search.parseDeezerTracks(text)
        shell.check("live results", rows.length > 0, true)
        if (rows.length) {
          console.log("      live: " + rows[0].title + " - " + rows[0].artist)
          // Whatever a catalogue says, the probe is the only gate on its art.
          shell.check("live art vetted", Model.artProbeTarget(rows[0].artwork) !== null, true)
        }
        report()
      }
    }
  }

  function report() {
    console.log("")
    if (failures) console.warn("FAILED " + failures + " of " + checks + " checks")
    else console.log("ok - " + checks + " checks passed under the QML engine")
    Qt.exit(failures ? 1 : 0)
  }

  function live() {
    probe.command = ["/bin/sh", "-c", Search.fetchScript(), "sh", Search.searchUrl("track", "daft punk", 3)]
    probe.running = true

    // Never hang the run on a network that is not answering.
    guard.restart()
  }

  Timer {
    id: guard
    interval: 20000
    onTriggered: {
      console.warn("FAIL  live request timed out")
      Qt.exit(1)
    }
  }
}
