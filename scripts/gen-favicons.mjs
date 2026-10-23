/**
 * The tab icons, cut from the brain mark in web/public/logo.png.
 *
 * Writes web/public/favicon-32.png (tabs), apple-touch-icon.png (180px,
 * on the page's deep background, since iOS shows no transparency) and
 * favicon-192.png. Rerun after the logo changes: node scripts/gen-favicons.mjs
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
console.log("Wrote favicon-32.png, favicon-192.png and apple-touch-icon.png.");
