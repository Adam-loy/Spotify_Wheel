// Structure checks for Panel.qml.
//
// These exist because `qmllint` passed a file Quickshell refused to load. It
// reported nothing at all on a Panel.qml with a stray brace, and the only clue
// was the shell's log: "Plugin widget failed: Syntax error". So the check that
// actually matters -- does this file nest the way it is supposed to -- is done
// here instead, where a failure is a failure rather than a log line nobody is
// reading.
//
//   node test/qml-test.js

const assert = require("assert")
const fs = require("fs")
const path = require("path")

const panel = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")
const lines = panel.split("\n")

// --------------------------------------------------------------- balance
//
// Counting braces with a regex is wrong the moment a comment or a string
// contains one, and this file has both: a Nerd Font glyph in a string, and
// comments about braces. So walk it, skipping string literals and comments,
// and keep the running depth.
function walk(startDepth = 0) {
  const found = []
  let depth = startDepth
  let line = 0
  let inLineComment = false
  let inBlockComment = false
  let inString = null
  let escaped = false

  for (let i = 0; i < panel.length; i++) {
    const ch = panel[i]
    const next = panel[i + 1]
    if (ch === "\n") { line++; inLineComment = false; continue }

    if (inLineComment) continue
    if (inBlockComment) {
      if (ch === "*" && next === "/") { inBlockComment = false; i++ }
      continue
    }
    if (inString) {
      if (escaped) { escaped = false; continue }
      if (ch === "\\") { escaped = true; continue }
      if (ch === inString) inString = null
      continue
    }

    if (ch === "/" && next === "/") { inLineComment = true; i++; continue }
    if (ch === "/" && next === "*") { inBlockComment = true; i++; continue }
    if (ch === '"' || ch === "'") { inString = ch; continue }

    if (ch === "{") { depth++; found.push({ line: line + 1, depth, open: true }) }
    if (ch === "}") {
      depth--
      found.push({ line: line + 1, depth, open: false })
      assert.ok(depth >= 0, "a closing brace at line " + (line + 1) + " has nothing to close")
    }
  }

  assert.equal(inString, null, "an unterminated string literal")
  assert.equal(inBlockComment, false, "an unterminated block comment")
  return { depth, found }
}

const walkResult = walk()
assert.equal(walkResult.depth, 0,
  "braces do not balance: the file ends " + walkResult.depth + " deep, so something is unclosed")

// Brackets and parentheses, for the same reason and with the same walk.
function countOutsideStrings(text, open, close) {
  let n = 0
  let inString = null
  let inLineComment = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === "\n") { inLineComment = false; continue }
    if (inLineComment) continue
    if (inString) {
      if (escaped) { escaped = false; continue }
      if (ch === "\\") { escaped = true; continue }
      if (ch === inString) inString = null
      continue
    }
    if (ch === "/" && text[i + 1] === "/") { inLineComment = true; i++; continue }
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2)
      assert.ok(close !== -1, "unterminated block comment")
      i = close + 1
      continue
    }
    if (ch === '"' || ch === "'") { inString = ch; continue }
    if (ch === open) n++
    if (ch === close) n--
  }
  return n
}

assert.equal(countOutsideStrings(panel, "(", ")"), 0, "parentheses do not balance")
assert.equal(countOutsideStrings(panel, "[", "]"), 0, "square brackets do not balance")

// ------------------------------------------------------------ nesting shape
//
// Balance alone is not enough. A file can balance and still be wrong: the
// mistake that reached the shell here was one extra `}`, which balanced the
// file overall only because the root's own `}` had nothing left to close, and
// the real damage was that the IpcHandler ended up as a sibling of Panel
// rather than a child of it, so the widget loaded no handlers and every IPC
// call answered "Target not found".
const rootOpen = walkResult.found.find((f) => f.open)
assert.equal(rootOpen.depth, 1, "the file's first object should be the root")
assert.equal(rootOpen.line, 11, "the root moved; the first object is no longer Panel")

const ipc = walkResult.found.find((f) => f.line === lines.findIndex((l) => l.includes("IpcHandler {")) + 1)
assert.ok(ipc, "no IpcHandler found")
// Depth 2 means "one object inside Panel", which is where a bar widget's
// handler has to be.
assert.equal(ipc.depth, 2,
  "the IpcHandler is at depth " + ipc.depth + ", not 2: it is no longer inside Panel, " +
  "so it registers nothing and every IPC call fails with 'Target not found'")

// The root must close on the last non-empty line, or something after it is
// outside the widget entirely.
const lastNonEmpty = lines.map((l, i) => [i + 1, l]).filter(([, l]) => l.trim()).pop()[0]
const lastClose = walkResult.found.filter((f) => !f.open).pop()
assert.equal(lastClose.line, lastNonEmpty,
  "the last closing brace is at line " + lastClose.line + " but the last line with " +
  "anything on it is " + lastNonEmpty + ": something is outside the root object")

// --------------------------------------------------------------- handlers
//
// A handler that calls a function which does not exist is a runtime failure
// with no compile-time warning, and it is silent: the widget still loads, the
// keybinding just does nothing.
const declared = new Set()
for (const m of panel.matchAll(/^\s*function\s+([A-Za-z_]\w*)\s*\(/gm)) declared.add(m[1])
for (const m of panel.matchAll(/^\s*(?:readonly\s+)?property\s+[A-Za-z_][\w<>.]*\s+([A-Za-z_]\w*)\s*[:=]/gm)) {
  declared.add(m[1])
}
// Also ids, which are addressable as properties.
for (const m of panel.matchAll(/^\s*id:\s*([A-Za-z_]\w*)\s*$/gm)) declared.add(m[1])

const handlerBody = panel.slice(panel.indexOf("IpcHandler {"))
const missing = new Set()
for (const m of handlerBody.matchAll(/root\.([A-Za-z_]\w*)\s*\(/g)) {
  if (!declared.has(m[1])) missing.add(m[1])
}
assert.equal(missing.size, 0,
  "the IpcHandler calls root." + [...missing].join(", root.") + ", which is not defined")

console.log("ok — qml structure tests passed")
