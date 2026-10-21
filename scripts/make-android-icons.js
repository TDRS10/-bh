// Generates the Android launcher icons + splash screens from the app logo.
// Requires: sharp (npm install sharp --save-dev)
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');
const LOGO = path.join(ROOT, 'logo.jpg');
const ICON_512 = path.join(ROOT, 'icon-512.png');

const DENSITIES = [
  ['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]
];

const SPLASH = [
  ['mdpi', 320, 480], ['hdpi', 480, 800], ['xhdpi', 720, 1280],
  ['xxhdpi', 960, 1600], ['xxxhdpi', 1280, 1920]
];

function ensure(dir) { fs.mkdirSync(dir, { recursive: true }); }

async function makeIcon(src, size, out) {
  await sharp(src)
    .resize(size, size, { fit: 'cover' })
    .png()
    .toFile(out);
}

// Maskable icon: logo centered on a solid background (Android crops it to a shape)
async function makeMaskable(src, size, out) {
  const logoSize = Math.round(size * 0.68);
  const logo = await sharp(src).resize(logoSize, logoSize, { fit: 'contain' }).png().toBuffer();
  await sharp({
    create: { width: size, height: size, channels: 4, background: '#04060A' }
  })
    .composite([{ input: logo, gravity: 'center' }])
    .png()
    .toFile(out);
}

async function makeSplash(out, w, h) {
  // Dark background with the logo centered inside a circle
  const logoSize = Math.round(Math.min(w, h) * 0.42);
  const logo = await sharp(ICON_512)
    .resize(logoSize, logoSize, { fit: 'cover' })
    .png()
    .toBuffer();

  // Circular mask
  const svg = `<svg width="${logoSize}" height="${logoSize}">
    <circle cx="${logoSize / 2}" cy="${logoSize / 2}" r="${logoSize / 2}" fill="#fff"/>
  </svg>`;
  const mask = await sharp(Buffer.from(svg)).png().toBuffer();

  const roundLogo = await sharp(logo)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();

  await sharp({
    create: { width: w, height: h, channels: 4, background: '#04060A' }
  })
    .composite([{ input: roundLogo, gravity: 'center' }])
    .png()
    .toFile(out);
}

(async () => {
  for (const [density, size] of DENSITIES) {
    const dir = path.join(RES, 'mipmap-' + density);
    ensure(dir);
    await makeIcon(ICON_512, size, path.join(dir, 'ic_launcher.png'));
    await makeIcon(ICON_512, size, path.join(dir, 'ic_launcher_round.png'));
    await makeMaskable(ICON_512, size, path.join(dir, 'ic_launcher_foreground.png'));
    console.log('icons ->', density, size);
  }

  for (const [density, w, h] of SPLASH) {
    const dir = path.join(RES, 'drawable-' + density);
    ensure(dir);
    await makeSplash(path.join(dir, 'splash.png'), w, h);
    console.log('splash ->', density, w + 'x' + h);
  }

  // Notification icon (small, white on transparent)
  const notifDir = path.join(RES, 'drawable');
  ensure(notifDir);
  const nsize = 96;
  await sharp(ICON_512)
    .resize(nsize, nsize, { fit: 'contain' })
    .ensureAlpha()
    .toColourspace('b-w')
    .png()
    .toFile(path.join(notifDir, 'ic_notification_icon.png'));
  console.log('notification icon done');

  console.log('ALL ANDROID ASSETS GENERATED');
})();
