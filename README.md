# Spotify_Wheel

A Spotify widget for the [Omarchy](https://omarchy.dev) bar. It stays in the bar
whether or not Spotify is running, adds search and a new releases tab, and has a
button for keeping the music playing with no window in the way.


## What is different from upstream

- **Always in the bar.** Upstream hides the slot when Spotify is closed. This
  one keeps a dimmed `Spotify` label and the icon there, so it is a way to start
  the app and search without hunting for it. The setting still exists if you
  would rather it got out of the way.
- **Search and new releases**, in two extra tabs. Spotify's own Web API is not
  used at all — see [Where the data comes from](#where-the-data-comes-from).
- **Start / Show app**, which runs Spotify with no window at all. See
  [Background playback](#background-playback).
- **Clear cache**, which empties Spotify's caches so the next start is quicker.

## No Premium, and no Spotify API

Everything here works on a free Spotify account. Two things follow from that,
and they shape the whole design.

**The Spotify Web API is off limits.** Since February 2026 it requires a Premium
app owner, and `/browse/new-releases` is gone. So there is no "current
playback", no "your library", and no official new releases feed. What the widget
shows on screen still comes from Spotify over MPRIS, which needs no account and
no key. Only *discovery* — search and new releases — has to come from elsewhere.

**`spotifyd` is not used.** It would be the proper way to run Spotify as a
headless player, but it needs Premium, and a free account cannot use it.

### Opening a result

Because there is no API, a catalogue hit cannot be turned into a Spotify track
by ID. Clicking a result hands Spotify a `spotify:search:` URI for that title
and artist through MPRIS, which opens the search inside the app. It is a
handoff, not playback.

## Where the data comes from

| Tab | Source | Notes |
| --- | --- | --- |
| Now playing | Spotify, over MPRIS | No key, no account, no network |
| Search, tracks | [Deezer](https://www.deezer.com) | Public JSON, no auth |
| Search, albums | [Deezer](https://www.deezer.com) | Public JSON, no auth |
| New releases | [Apple's search API](https://performance-partners.apple.com/search-api) | Public JSON, no auth |

Both catalogues are asked through a generated `sh` script rather than fetched
straight from QML. It allowlists the two hosts, caps the response at 2 MB,
refuses redirects and follows no cookies, and rejects a body that does not start
with `{` or `[` — which is what a captive portal or a proxy error page looks
like, and which would otherwise turn into a parse error in the panel.

### The new releases tab is honest about its own limits

Apple's search supports `sort=recent`, but it means *recent, among the things
that match* — relevance still outranks date. Ask it for `jazz` and the top of
the page is a 1956 compilation also called *Jazz*. So the tab re-sorts the
answer newest-first, and puts the release date next to every row.

That is not cosmetic. Apple's free index is unevenly fresh, and the tab will
show you which: `hip hop` has records from this month at the top, `jazz` stops
around 2023. It is a good list of what Apple's index has, not a complete feed of
everything released. Deezer's editorial "new releases" endpoints, which would
have been a better source, now answer empty.

## Background playback

The point of the widget is that you can listen to Spotify without ever seeing
Spotify. **Start** launches it and puts its window on a Hyprland *special
workspace*, so playback begins and the window is somewhere you cannot land on
by accident. **Show app** takes it back off and puts it on whatever workspace
you are looking at, following it there.

The special workspace is `special:spotify` rather than the conventional
`special:minimized`, specifically so that toggling it cannot disturb a scratchpad
you have bound to something of your own.

**This is not a daemon.** On a free account there is no supported way to run
Spotify without its window: `spotifyd` needs Premium, as does Spotify's own
Soloist client. So the process is real, the window is just somewhere you are
not. If you want no process at all, that needs Premium.

Two details are worth knowing if you read `Model.js`:

- Hyprland 0.55 moved dispatchers behind a Lua layer, so this needs
  `hyprctl dispatch 'hl.dsp.window.move({ window = "address:0x…", workspace =
  "special:spotify", follow = false })'`. The old string form,
  `hyprctl dispatch movetoworkspace special:…`, is accepted and does nothing on
  0.56. Note that `hyprctl dispatch` wraps the expression in `hl.dispatch` for
  you; wrapping it again is an error.
- Because of exactly that, a successful exit code means nothing. The script
  re-reads the window's workspace afterwards and exits non-zero if it did not
  move, so a silent no-op cannot be reported to the panel as success.

`startOnLogin` does the same thing a few seconds after login. It is off by
default, because starting a music player unprompted is not a default anyone
would want.

## Clearing the cache

**Clear cache** empties the cache directories under `~/.cache/spotify` and
reports how much it freed.

It is deliberately narrow. `~/.cache/spotify/Browser` also holds the session,
so deleting the whole tree would sign you out; the script only removes named
cache subdirectories, and always leaves `Cookies`, `Login Data`, `Local Storage`,
`Preferences`, `Data`, and `Users` alone. `test/ops-test.js` builds a fake
profile and asserts the session files are still there afterwards.

Note that a cleared cache is a slower *next* start, not a faster current one —
the point is getting a clean, quick start after Spotify has had a long life.

## Artwork

Catalogue responses are not trusted with images. Every remote URL, the current
cover and every search result, goes through one probe that checks the host
against an allowlist of `scdn.co`, `dzcdn.net`, and `mzstatic.com`, then
downloads it to a local file with ImageMagick. The panel only ever loads a
`file://` path that probe wrote, so a hostile or lookalike host in a catalogue
body cannot reach the image loader — `evilscdn.co` and `dzcdn.net.evil.com`
are both refused.

## Settings

In the bar's settings panel, under Spotify:

| Setting | Default | |
| --- | --- | --- |
| Hide the widget when Spotify is not running | off | Turn on to hide the slot entirely |
| Search shows | Tracks | Or Albums |
| New releases starts on | pop | The genre the New tab asks for |
| Maximum label width | 200 | Wider titles scroll |
| Show artist | on | |
| Show progress | on | Underline in the bar |
| Left click | Open panel | The other button becomes play/pause |
| Mouse wheel | Previous/next track | Or volume |
| Accent color | Spotify green | Or album art, theme accent, bar foreground |
| Album cover behind the panel | on | |
| How much cover shows through | 55 | |

## IPC

For keybindings and scripts. `--` passes an argument.

```sh
omarchy-shell Spotify_Wheel toggle
omarchy-shell Spotify_Wheel playPause
omarchy-shell Spotify_Wheel next
omarchy-shell Spotify_Wheel previous
omarchy-shell Spotify_Wheel launch     # start, and hide the window
omarchy-shell Spotify_Wheel show       # bring the window back
omarchy-shell Spotify_Wheel minimize   # hide an already-open window
omarchy-shell Spotify_Wheel clearCache
omarchy-shell Spotify_Wheel search 'daft punk'
omarchy-shell Spotify_Wheel releases 'hip hop'
omarchy-shell Spotify_Wheel status
```

`status` and `searchDebug` return JSON for debugging.

## Requirements

- `curl` — the only hard one; search and releases do nothing without it.
- `ImageMagick` (`magick`) — album art and the cover backdrop. Without it the
  panel keeps its plain background and rows show no thumbnails.
- `jq` — the background-playback buttons.
- `hyprctl` — the background-playback buttons, on Hyprland 0.55 or newer for
  the Lua dispatcher form.

## Tests

```sh
node test/qml-test.js       # Panel.qml structure -- see below
node test/model-test.js     # MPRIS helpers, artwork probe, cache parsing
node test/search-test.js    # URLs, both parsers, host vetting, live catalogues
node test/ops-test.js       # background playback, cache clearing on a fake profile
sh   test/probe-test.sh     # the artwork gate, against hostile URLs

sh   test/run.sh            # all of the above
```

`qml-test.js` is not decoration. `qmllint` passes a `Panel.qml` that Quickshell
refuses to load -- it reported nothing at all on one with a stray brace, and the
only clue was the shell's log. The structure test is what catches that, so run
it first; `test/run.sh` does.

`search-test.js` makes live requests to both catalogues; it fails if either is
unreachable. The QML side is checked with `qmllint`, and `qml/harness.qml` runs
the two logic files under Quickshell's own JavaScript engine, which is not
Node's:

```sh
qml/harness.qml   # symlink Model.js and Search.js beside it, then:
QML_IMPORT_PATH=/usr/share/omarchy/shell:/usr/lib/qt6/qml qs -p harness.qml
```

That harness has already earned its place: it is what caught `StdioCollector`
handlers that read a `text` argument the signal does not pass, which Node never
noticed and which would have left search, thumbnails, and cache clearing all
silently broken in the bar.

## Install

```sh
ln -s "$PWD" ~/.config/omarchy/plugins/
omarchy restart shell
```

Then enable it: `omarchy plugin enable Spotify_Wheel`, or add
`{"id": "Spotify_Wheel"}` to `bar.layout.center` in `~/.config/omarchy/shell.json`.

The plugin is a symlink so that editing it in place reloads the widget without
reinstalling.

## Licence

