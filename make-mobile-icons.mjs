// One-off: regenerate mobile/assets icons from the 66AI logo (app/assets/icon-source.jpg).
// Run from app/ so sharp resolves:  node ../../make-mobile-icons.mjs  (cwd must be app/)
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire('E:/AIbot/66AI-Bot/app/package.json')
const sharp = require('sharp')
const ASSETS = 'E:/AIbot/66AI-Bot/mobile/assets'
const SOURCE = 'E:/AIbot/66AI-Bot/app/assets/icon-source.jpg'

async function png(file, size, { shrink = 1 } = {}) {
  // `shrink` keeps the mark inside a safe zone (Android adaptive foreground) by resizing the
  // logo onto a transparent canvas of the same size.
  if (shrink === 1) {
    await sharp(SOURCE).resize(size, size, { fit: 'cover' }).png().toFile(`${ASSETS}/${file}`)
  } else {
    const inner = Math.round(size * shrink)
    const mark = await sharp(SOURCE).resize(inner, inner, { fit: 'cover' }).png().toBuffer()
    await sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: mark, gravity: 'centre' }])
      .png()
      .toFile(`${ASSETS}/${file}`)
  }
  console.log('wrote', file, size)
}

await png('icon.png', 1024)
await png('splash-icon.png', 1024)
await png('favicon.png', 48)
// Android adaptive: foreground keeps the mark inside the safe zone (center ~2/3).
await png('android-icon-foreground.png', 512, { shrink: 0.62 })
// The background layer is a plain tint close to the logo's own plate.
{
  const bg = '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#0B1B3A"/></svg>'
  await sharp(Buffer.from(bg)).png().toFile(`${ASSETS}/android-icon-background.png`)
  console.log('wrote android-icon-background.png 512')
}
// The monochrome layer carries the mark as alpha, like app/scripts/icon.mjs's template.
{
  const { data, info } = await sharp(SOURCE).grayscale().resize(432, 432, { fit: 'cover' }).raw().toBuffer({ resolveWithObject: true })
  const rgba = Buffer.alloc(info.width * info.height * 4)
  for (let at = 0; at < info.width * info.height; at += 1) {
    rgba[at * 4] = 0
    rgba[at * 4 + 1] = 0
    rgba[at * 4 + 2] = 0
    rgba[at * 4 + 3] = data[at]
  }
  await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(`${ASSETS}/android-icon-monochrome.png`)
  console.log('wrote android-icon-monochrome.png 432')
}
console.log('done')
