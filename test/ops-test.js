// Tests for the things the widget does to Spotify itself: minimising it to a
// hidden workspace so it keeps playing with no window, clearing its caches so
// the next start is quicker, and reporting what that freed.
//
// The cache test runs the real script against a throwaway profile built to
// mirror a real one -- including the files that hold the signed-in session, so
// a change that widened the blast radius would be caught here rather than by
// the next person to press the button: `node test/ops-test.js`.

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { execFileSync } = require("child_process")
const M = require("../Model.js")

// ---------------------------------------------------------------- byte sizes
{
  assert.equal(M.humanBytes(0), "0 B")
  assert.equal(M.humanBytes(512), "512 B")
  assert.equal(M.humanBytes(2048), "2.0 KB")
  assert.equal(M.humanBytes(15360), "15 KB")
  assert.equal(M.humanBytes(15 * 1024 * 1024), "15 MB")
  assert.equal(M.humanBytes(1610612736), "1.5 GB")
  // Nonsense from a probe is not a negative number on screen.
  assert.equal(M.humanBytes(-5), "0 B")
  assert.equal(M.humanBytes("abc"), "0 B")
  assert.equal(M.humanBytes(undefined), "0 B")
}

// ------------------------------------------------------------- cache report
{
  assert.deepEqual(M.parseCacheClear("FREED 1048576\nDIRS 3\n"), { freed: 1048576, dirs: 3 })
  // A script that failed reports nothing, and the panel shows that rather than
  // a confident zero.
  assert.equal(M.parseCacheClear(""), null)
  assert.equal(M.parseCacheClear("rm: cannot remove"), null)
  assert.deepEqual(M.parseCacheClear("FREED 0\n"), { freed: 0, dirs: 0 })
}

// -------------------------------------------------------------- cache clear
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spoty-ops-"))
  const base = path.join(root, "spotify")

  // The regenerable Chromium caches, which are where the space actually is.
  const caches = [
    "Browser/Cache", "Browser/Code Cache", "Browser/GPUCache", "Browser/DawnWebGPUCache",
    "Default/Cache", "Default/GPUCache", "component_crx_cache", "Storage", "Crashpad",
    "Service Worker"
  ]
  for (const dir of caches) {
    fs.mkdirSync(path.join(base, dir), { recursive: true })
    fs.writeFileSync(path.join(base, dir, "blob"), Buffer.alloc(4096, 7))
  }

  // The signed-in session. None of these may ever be removed, and they live
  // *inside* the same profile directories as the caches above, which is the
  // trap this test exists to catch.
  const session = [
    "Browser/Cookies", "Browser/Login Data", "Browser/Login Data For Account",
    "Browser/Local Storage/leveldb/000003.log", "Browser/Preferences",
    "Browser/IndexedDB/000004.log", "Browser/Web Data",
    "Default/Cookies", "Default/Login Data", "Default/Local Storage/leveldb/000003.log",
    "Default/Preferences",
    "Users/abc-user/prefs", "Data/blob.bin", "prefs"
  ]
  for (const rel of session) {
    fs.mkdirSync(path.join(base, path.dirname(rel)), { recursive: true })
    fs.writeFileSync(path.join(base, rel), "SESSION")
  }

  const out = execFileSync("/bin/sh", ["-c", M.clearCacheScript()], {
    encoding: "utf8", timeout: 30000,
    env: { ...process.env, XDG_CACHE_HOME: root },
    stdio: ["ignore", "pipe", "pipe"]
  })

  const report = M.parseCacheClear(out)
  assert.ok(report, "expected a cache report from the script")
  assert.ok(report.dirs > 0, "expected at least one directory to be cleared")
  assert.ok(report.freed > 0, "expected a non-zero byte count")

  // Every cache went, and everything holding the session stayed.
  for (const dir of caches) {
    assert.ok(!fs.existsSync(path.join(base, dir)), `${dir} should have been cleared`)
  }
  for (const rel of session) {
    const file = path.join(base, rel)
    assert.ok(fs.existsSync(file), `${rel} must never be removed`)
    assert.equal(fs.readFileSync(file, "utf8"), "SESSION", `${rel} was modified`)
  }

  // And this widget's own probe cache goes too, so a clear is a real cold start.
  const own = path.join(root, "Spotify_Wheel", "covers")
  fs.mkdirSync(own, { recursive: true })
  fs.writeFileSync(path.join(own, "x.png"), Buffer.alloc(512, 1))
  execFileSync("/bin/sh", ["-c", M.clearCacheScript()], {
    encoding: "utf8", timeout: 30000,
    env: { ...process.env, XDG_CACHE_HOME: root },
    stdio: ["ignore", "pipe", "pipe"]
  })
  assert.ok(!fs.existsSync(own), "the widget's own cache should be cleared")

  // A profile that is not there at all is not an error.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "spoty-empty-"))
  const bare = execFileSync("/bin/sh", ["-c", M.clearCacheScript()], {
    encoding: "utf8", timeout: 30000,
    env: { ...process.env, XDG_CACHE_HOME: empty },
    stdio: ["ignore", "pipe", "pipe"]
  })
  assert.ok(M.parseCacheClear(bare), "a missing profile should still report cleanly")

  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(empty, { recursive: true, force: true })
}

// ------------------------------------------------------- starting in background
//
// The widget is meant to be the whole player: audio up, the app never opened.
// On a free account that means putting Spotify's window on a special workspace
// it cannot be landed on, so the launch and the hide have to be one script --
// at the moment of launching there is no window yet, and a caller that looked
// immediately would find nothing and give up.
{
  const hide = M.spotifyBackgroundScript(false)
  const start = M.spotifyBackgroundScript(true)
  const show = M.spotifyShowScript()

  // A shell script explains itself in comments, and the explanations here
  // necessarily quote the syntax they are warning against -- so assertions about
  // what the script *does* have to be made against the code, not the prose.
  const code = (s) => s.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n")

  for (const script of [hide, start, show]) {
    assert.ok(script.indexOf("hyprctl clients -j") !== -1)
    assert.ok(script.indexOf("command -v hyprctl") !== -1)
    assert.ok(script.indexOf("command -v jq") !== -1)
    // The address reaches a Lua string literal, so it is checked against what
    // Hyprland emits before it is used for anything.
    assert.ok(script.indexOf("0x*[0-9a-fA-F]*") !== -1)
    assert.ok(script.indexOf("*[!0-9a-fA-Fx]*") !== -1)
  }

  // Hyprland 0.55 moved dispatchers behind Lua. The old string form is a silent
  // no-op on 0.56, so this is exactly the thing that has to be right.
  for (const script of [hide, start]) {
    assert.ok(code(script).indexOf("hl.dsp.window.move") !== -1,
      "must use the Lua dispatcher form")
    assert.ok(code(script).indexOf("address:$addr") !== -1,
      "the window needs an address: selector")
    assert.ok(code(script).indexOf("follow = false") !== -1,
      "follow = true would pull the user onto the window being hidden")
    assert.equal(code(script).indexOf("hyprctl dispatch movetoworkspace"), -1,
      "the pre-0.55 string dispatcher is a no-op here")
  }

  // Our own scratchpad, not the conventional "minimized", so that toggling it
  // can never disturb one the user has bound themselves.
  assert.ok(code(hide).indexOf(M.hiddenWorkspace) !== -1)
  assert.equal(M.hiddenWorkspace, "special:spotify")
  assert.equal(code(hide).indexOf("special:minimized"), -1)

  // Only the launch variant launches, detached so that stopping the script does
  // not take the music with it.
  assert.ok(start.indexOf("omarchy launch spotify") !== -1)
  assert.ok(start.indexOf("setsid") !== -1)
  assert.equal(hide.indexOf("omarchy launch spotify"), -1)

  // Showing goes the other way, to wherever the user is.
  assert.ok(code(show).indexOf("activeworkspace") !== -1)
  assert.ok(code(show).indexOf("follow = true") !== -1)
  assert.equal(show.indexOf("setsid"), -1)

  // A no-op when nothing is open, and valid shell.
  const quiet = execFileSync("/bin/sh", ["-c", hide], {
    encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"]
  })
  assert.equal(quiet.trim(), "")

  // ------------------------------------------------------------- with a window
  //
  // Real hyprctl, real jq, and a fake that reports a Spotify window on a
  // workspace that the fake also records. The fake applies the move itself, so
  // a dispatch that is syntactically accepted but does nothing still fails the
  // script's own confirmation step -- which is the failure this is here for.
  const box = fs.mkdtempSync("/tmp/spoty-bg-")
  const bin = path.join(box, "bin")
  fs.mkdirSync(bin)
  const state = path.join(box, "ws")
  const calls = path.join(box, "calls")

  // The fake is stateful: `clients` reports whatever workspace is in the state
  // file, so a dispatch that is accepted but does nothing leaves the script's
  // own confirmation step to notice.
  fs.writeFileSync(path.join(bin, "hyprctl"), `#!/bin/sh
ws=$(cat ${JSON.stringify(state)} 2>/dev/null || echo 1)
case "$1" in
  clients)
    case "$ws" in
      special:*) echo '[{"class":"Spotify","title":"Spotify Free","workspace":{"id":-97,"name":"special:spotify"},"address":"0xabc"}]' ;;
      *)         echo '[{"class":"Spotify","title":"Spotify Free","workspace":{"id":1,"name":"1"},"address":"0xabc"}]' ;;
    esac ;;
  activeworkspace) echo '{"id":1,"name":"1"}' ;;
  dispatch)
    echo "dispatch $*" >> ${JSON.stringify(calls)}
    case "$*" in
      *"special:spotify"*) echo "special:spotify" > ${JSON.stringify(state)} ;;
      *"workspace = 1"*)    echo "1" > ${JSON.stringify(state)} ;;
    esac ;;
esac
`)

  // The real jq, so the selection query is genuinely exercised.
  fs.symlinkSync("/usr/bin/jq", path.join(bin, "jq"))
  fs.writeFileSync(path.join(bin, "omarchy"), `#!/bin/sh
echo "omarchy $*" >> ${JSON.stringify(calls)}
`)
  for (const f of ["hyprctl", "omarchy"]) fs.chmodSync(path.join(bin, f), 0o755)

  const env = { ...process.env, PATH: bin + ":" + process.env.PATH }

  // ---- hide
  fs.writeFileSync(state, "1")
  const r1 = execFileSync("/bin/sh", ["-c", hide], {
    encoding: "utf8", timeout: 30000, env, stdio: ["ignore", "pipe", "pipe"]
  })
  assert.equal(r1.trim(), "")
  const seen1 = fs.readFileSync(calls, "utf8")
  assert.ok(seen1.includes("hl.dsp.window.move"), "should have dispatched: " + seen1)
  assert.ok(seen1.includes('address:0xabc'), "should have used an address: selector")
  assert.ok(seen1.includes("special:spotify"), "should have asked for our scratchpad")
  assert.equal(fs.readFileSync(state, "utf8").trim(), "special:spotify", "window should be hidden")

  // ---- launch as well
  fs.appendFileSync(calls, "")
  const r2 = execFileSync("/bin/sh", ["-c", start], {
    encoding: "utf8", timeout: 30000, env, stdio: ["ignore", "pipe", "pipe"]
  })
  assert.equal(r2.trim(), "")
  const seen2 = fs.readFileSync(calls, "utf8")
  assert.ok(seen2.includes("omarchy launch spotify"), "should have launched Spotify")

  // ---- show
  fs.writeFileSync(path.join(bin, "hyprctl"), `#!/bin/sh
case "$1" in
  clients)  echo '[{"class":"Spotify","title":"x","workspace":{"id":-97,"name":"special:spotify"},"address":"0xabc"}]' ;;
  activeworkspace) echo '{"id":1,"name":"1"}' ;;
  dispatch) echo "dispatch $*" >> ${JSON.stringify(calls)}
            case "$*" in
              *"workspace = 1"*) echo "1" > ${JSON.stringify(state)} ;;
            esac ;;
esac
`)
  fs.chmodSync(path.join(bin, "hyprctl"), 0o755)
  fs.appendFileSync(calls, "")

  const r3 = execFileSync("/bin/sh", ["-c", show], {
    encoding: "utf8", timeout: 30000, env, stdio: ["ignore", "pipe", "pipe"]
  })
  assert.equal(r3.trim(), "")
  const seen3 = fs.readFileSync(calls, "utf8")
  assert.ok(seen3.includes("workspace = 1"), "should have moved to the current workspace: " + seen3)
  assert.ok(seen3.includes("follow = true"), "should have followed the window there")

  // ------------------------------------------- a dispatch that does nothing
  //
  // This is the one that would have shipped: the old script exited 0 the moment
  // it called a dispatcher that 0.56 quietly ignores, so the widget reported a
  // hidden window while Spotify sat in plain view. Now the script re-reads the
  // workspace and fails if the window is still visible.
  fs.writeFileSync(path.join(bin, "hyprctl"), `#!/bin/sh
case "$1" in
  clients)  echo '[{"class":"Spotify","title":"x","workspace":{"id":1,"name":"1"},"address":"0xabc"}]' ;;
  dispatch) exit 0 ;;   # accepted, and does nothing, exactly like the old bug
esac
`)
  fs.chmodSync(path.join(bin, "hyprctl"), 0o755)

  let failed = false
  try {
    execFileSync("/bin/sh", ["-c", hide], {
      encoding: "utf8", timeout: 30000, env, stdio: ["ignore", "pipe", "pipe"]
    })
  } catch (e) {
    failed = true
    assert.ok(String(e.stderr).includes("still on workspace"),
      "the failure should say the window did not move, got: " + e.stderr)
  }
  assert.ok(failed, "a dispatch that silently does nothing must not be reported as success")

  // ------------------------------------------------------ a hostile address
  //
  // The address is interpolated into a Lua string. It comes from Hyprland, but
  // it is still checked, because "it is our own compositor" is not a reason to
  // stop checking.
  fs.writeFileSync(path.join(bin, "hyprctl"), `#!/bin/sh
case "$1" in
  clients) echo '[{"class":"Spotify","workspace":{"id":1,"name":"1"},"address":"0xabc\\"} or os.exit(1) --"}]' ;;
esac
`)
  fs.chmodSync(path.join(bin, "hyprctl"), 0o755)

  let refused = false
  try {
    execFileSync("/bin/sh", ["-c", hide], {
      encoding: "utf8", timeout: 30000, env, stdio: ["ignore", "pipe", "pipe"]
    })
  } catch (e) {
    refused = /refusing a window address/.test(String(e.stderr))
  }
  assert.ok(refused, "a non-hex address should be refused before it reaches Lua")

  fs.rmSync(box, { recursive: true, force: true })
}

console.log("ok — ops tests passed")
