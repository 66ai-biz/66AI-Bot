// Draws the app icon from the 66AI logo (assets/icon-source.jpg) and writes assets/icon.png
// (1024 px), assets/icon.ico (Windows, 16 to 256 px) and the tray marks: assets/tray.ico
// (Windows), assets/tray.png (Linux) and assets/trayTemplate.png with its @2x (macOS).
// Usage: npm run icon.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const sharp = require('sharp')

const here = fileURLToPath(import.meta.url)
const assets = join(here, '..', '..', 'assets')
const source = join(assets, 'icon-source.jpg')
const ICO_SIZES = [16, 20, 24, 32, 36, 40, 48, 64, 72, 96, 128, 256]
// The tray icon is small: the sizes a notification area shows, and one plain png for Linux.
const TRAY_ICO_SIZES = [16, 20, 24, 32]
const TRAY_PNG_SIZE = 24
// macOS draws a template image itself, in the colour of the menu bar: a black mark with the
// shape of the logo.
const TRAY_TEMPLATE_SIZES = [16, 32]

// PNG entries in an .ico file, which Windows reads since Vista.
function icoFile(images) {
  const head = Buffer.alloc(6 + 16 * images.length)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(images.length, 4)
  let offset = head.length
  images.forEach(({ size, png }, index) => {
    const at = 6 + 16 * index
    head.writeUInt8(size >= 256 ? 0 : size, at)
    head.writeUInt8(size >= 256 ? 0 : size, at + 1)
    head.writeUInt16LE(1, at + 4)
    head.writeUInt16LE(32, at + 6)
    head.writeUInt32LE(png.length, at + 8)
    head.writeUInt32LE(offset, at + 12)
    offset += png.length
  })
  return Buffer.concat([head, ...images.map(image => image.png)])
}

/** One square PNG of the logo at `size`, with the pixel data behind the JPEG's soft edges. */
async function png(size) {
  return sharp(source).resize(size, size, { fit: 'cover' }).png().toBuffer()
}

// The macOS template: the menu bar paints the mark itself, so the icon carries the logo's
// shape as alpha (bright logo on a dark plate turns into a smooth black silhouette).
async function templatePng(size) {
  const { data, info } = await sharp(source)
    .grayscale()
    .resize(size, size, { fit: 'cover' })
    .raw()
    .toBuffer({ resolveWithObject: true })
  const rgba = Buffer.alloc(info.width * info.height * 4)
  for (let at = 0; at < info.width * info.height; at += 1) {
    rgba[at * 4] = 0
    rgba[at * 4 + 1] = 0
    rgba[at * 4 + 2] = 0
    rgba[at * 4 + 3] = data[at]
  }
  return sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer()
}

const icon = ICO_SIZES.map(size => ({ size, png: undefined }))
const tray = TRAY_ICO_SIZES.map(size => ({ size, png: undefined }))
const [large, ...small] = await Promise.all([
  png(1024),
  ...icon.map(entry => png(entry.size)),
  ...tray.map(entry => png(entry.size)),
  png(TRAY_PNG_SIZE),
  ...TRAY_TEMPLATE_SIZES.map(size => templatePng(size)),
])
icon.forEach((entry, index) => { entry.png = small[index] })
tray.forEach((entry, index) => { entry.png = small[ICO_SIZES.length + index] })
const trayPng = small[ICO_SIZES.length + TRAY_ICO_SIZES.length]
const templates = small.slice(ICO_SIZES.length + TRAY_ICO_SIZES.length + 1)
const { writeFileSync } = await import('node:fs')
writeFileSync(join(assets, 'icon.png'), large)
writeFileSync(join(assets, 'icon.ico'), icoFile(icon))
writeFileSync(join(assets, 'tray.ico'), icoFile(tray))
writeFileSync(join(assets, 'tray.png'), trayPng)
writeFileSync(join(assets, 'trayTemplate.png'), templates[0])
writeFileSync(join(assets, 'trayTemplate@2x.png'), templates[1])
console.log('icon: wrote assets/icon.png, assets/icon.ico and the tray marks from assets/icon-source.jpg')
