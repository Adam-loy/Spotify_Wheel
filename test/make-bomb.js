// Writes a valid PNG that is tiny on disk and enormous when decoded: the
// fixture the byte bounds cannot catch and the area limit has to.
//
//   node test/make-bomb.js <path> [edge]
//
// Built by streaming zeroed scanlines through zlib rather than by asking an
// image library for the pixels, because allocating the real thing is the very
// cost this fixture exists to prove is worth avoiding.

const { createDeflate } = require("node:zlib")
const { createWriteStream } = require("node:fs")

const output = process.argv[2]
const edge = Number(process.argv[3] || 12000)
if (!output) {
  console.error("usage: node test/make-bomb.js <path> [edge]")
  process.exit(2)
}

function chunk(type, body) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length, 0)
  const typed = Buffer.concat([Buffer.from(type, "ascii"), body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed), 0)
  return Buffer.concat([length, typed, crc])
}

const crcTable = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i++) c = crcTable[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const header = Buffer.alloc(13)
header.writeUInt32BE(edge, 0)   // width
header.writeUInt32BE(edge, 4)   // height
header[8] = 8                   // bit depth
header[9] = 2                   // truecolour
// compression, filter, interlace all 0

const file = createWriteStream(output)
file.write(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
file.write(chunk("IHDR", header))

const parts = []
const deflate = createDeflate({ level: 9 })
deflate.on("data", (part) => parts.push(part))
deflate.on("end", () => {
  file.write(chunk("IDAT", Buffer.concat(parts)))
  file.write(chunk("IEND", Buffer.alloc(0)))
  file.end()
})

// One filter byte plus three bytes per pixel, per row. Written a row at a time
// so nothing here ever holds the decoded size in memory.
const row = Buffer.alloc(1 + edge * 3)
let written = 0
function pump() {
  while (written < edge) {
    written++
    if (!deflate.write(row)) {
      deflate.once("drain", pump)
      return
    }
  }
  deflate.end()
}
pump()
