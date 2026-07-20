import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'

const size = 256
const scale = 4
const large = size * scale

function insideRoundedSquare(x, y) {
  const inset = 14 * scale
  const radius = 54 * scale
  const left = inset
  const right = large - inset
  const top = inset
  const bottom = large - inset
  if (x >= left + radius && x <= right - radius && y >= top && y <= bottom) return true
  if (y >= top + radius && y <= bottom - radius && x >= left && x <= right) return true
  const centers = [
    [left + radius, top + radius], [right - radius, top + radius],
    [left + radius, bottom - radius], [right - radius, bottom - radius]
  ]
  return centers.some(([cx, cy]) => (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2)
}

function triangleSign(px, py, ax, ay, bx, by) {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by)
}

function insideTriangle(x, y) {
  const a = [102 * scale, 78 * scale]
  const b = [102 * scale, 178 * scale]
  const c = [180 * scale, 128 * scale]
  const d1 = triangleSign(x, y, ...a, ...b)
  const d2 = triangleSign(x, y, ...b, ...c)
  const d3 = triangleSign(x, y, ...c, ...a)
  return !(d1 < 0 || d2 < 0 || d3 < 0) || !(d1 > 0 || d2 > 0 || d3 > 0)
}

const rgba = Buffer.alloc(size * size * 4)
for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    let red = 0
    let green = 0
    let blue = 0
    let alpha = 0
    for (let sy = 0; sy < scale; sy += 1) {
      for (let sx = 0; sx < scale; sx += 1) {
        const px = x * scale + sx + 0.5
        const py = y * scale + sy + 0.5
        if (!insideRoundedSquare(px, py)) continue
        const play = insideTriangle(px, py)
        const gradient = py / large
        red += play ? 255 : Math.round(225 - 35 * gradient)
        green += play ? 255 : Math.round(29 - 11 * gradient)
        blue += play ? 255 : Math.round(72 - 12 * gradient)
        alpha += 255
      }
    }
    const samples = scale * scale
    const offset = (y * size + x) * 4
    rgba[offset] = Math.round(red / samples)
    rgba[offset + 1] = Math.round(green / samples)
    rgba[offset + 2] = Math.round(blue / samples)
    rgba[offset + 3] = Math.round(alpha / samples)
  }
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const name = Buffer.from(type)
  const output = Buffer.alloc(12 + data.length)
  output.writeUInt32BE(data.length, 0)
  name.copy(output, 4)
  data.copy(output, 8)
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length)
  return output
}

const scanlines = Buffer.alloc((size * 4 + 1) * size)
for (let y = 0; y < size; y += 1) {
  const target = y * (size * 4 + 1)
  scanlines[target] = 0
  rgba.copy(scanlines, target + 1, y * size * 4, (y + 1) * size * 4)
}
const header = Buffer.alloc(13)
header.writeUInt32BE(size, 0)
header.writeUInt32BE(size, 4)
header[8] = 8
header[9] = 6
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(scanlines, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

const icoHeader = Buffer.alloc(22)
icoHeader.writeUInt16LE(0, 0)
icoHeader.writeUInt16LE(1, 2)
icoHeader.writeUInt16LE(1, 4)
icoHeader[6] = 0
icoHeader[7] = 0
icoHeader[8] = 0
icoHeader[9] = 0
icoHeader.writeUInt16LE(1, 10)
icoHeader.writeUInt16LE(32, 12)
icoHeader.writeUInt32LE(png.length, 14)
icoHeader.writeUInt32LE(22, 18)

mkdirSync('resources', { recursive: true })
writeFileSync('resources/icon.png', png)
writeFileSync('resources/icon.ico', Buffer.concat([icoHeader, png]))
