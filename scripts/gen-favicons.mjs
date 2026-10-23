/**
 * The tab icons, cut from the brain mark in web/public/logo.png.
 *
 * Writes web/public/favicon-32.png (tabs), apple-touch-icon.png (180px,
 * on the page's deep background, since iOS shows no transparency),
 * favicon-192.png, and the web app manifest's icons (M5.5): icon-512.png,
 * and icon-maskable-192.png / icon-maskable-512.png on the deep background
 * with the mark inside the maskable safe zone (the centre circle of 80%
 * diameter, so the mark's square spans at most 0.8 / sqrt 2, about 57%).
 * Also logo.webp (M5.5): the header lockup at three times its 50px display
 * height, since the 2000px PNG is the page's LCP element on phones.
 * Rerun after the logo changes: node scripts/gen-favicons.mjs
 */
import sharp from "sharp";

const SOURCE = "web/public/logo.png";
// The mark's box in logo.png (2000×708): the brain spans x 0–802.
const MARK = { left: 0, top: 0, width: 804, height: 708 };
const DEEP = { r: 3, g: 3, b: 18, alpha: 1 }; // --bg-deep, dark

async function square(size, { background = { r: 0, g: 0, b: 0, alpha: 0 }, pad = 0 } = {}) {
	const inner = size - pad * 2;
	const mark = await sharp(SOURCE)
		.extract(MARK)
		.resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
		.png()
		.toBuffer();
	return sharp({ create: { width: size, height: size, channels: 4, background } })
		.composite([{ input: mark, left: pad, top: pad }])
		.png({ compressionLevel: 9 });
}

await (await square(32, { pad: 1 })).toFile("web/public/favicon-32.png");
await (await square(192, { pad: 8 })).toFile("web/public/favicon-192.png");
await (await square(180, { background: DEEP, pad: 22 })).toFile("web/public/apple-touch-icon.png");
await (await square(512, { pad: 20 })).toFile("web/public/icon-512.png");
// Maskable: 22% padding each side keeps the mark inside the safe circle.
await (await square(192, { background: DEEP, pad: 42 })).toFile("web/public/icon-maskable-192.png");
await (await square(512, { background: DEEP, pad: 112 })).toFile("web/public/icon-maskable-512.png");
await sharp(SOURCE).resize({ height: 150 }).webp({ quality: 90, alphaQuality: 100, effort: 6 }).toFile("web/public/logo.webp");
console.log("Wrote logo.webp, favicon-32.png, favicon-192.png, apple-touch-icon.png, icon-512.png and the maskable icons.");
