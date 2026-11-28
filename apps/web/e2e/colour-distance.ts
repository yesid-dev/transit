/** sRGB channels (0 to 255) to CIELAB under D65. */
function lab([red, green, blue]: readonly number[]): [number, number, number] {
	const [r, g, b] = [red, green, blue].map((channel) => {
		const s = channel! / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
	const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
	const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
	const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
	return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** CIEDE2000 colour difference between two sRGB colours. */
export function deltaE00(first: readonly number[], second: readonly number[]): number {
	const [l1, a1, b1] = lab(first);
	const [l2, a2, b2] = lab(second);
	const meanChroma = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
	const g = 0.5 * (1 - Math.sqrt(meanChroma ** 7 / (meanChroma ** 7 + 25 ** 7)));
	const a1p = a1 * (1 + g);
	const a2p = a2 * (1 + g);
	const c1 = Math.hypot(a1p, b1);
	const c2 = Math.hypot(a2p, b2);
	const hue = (a: number, b: number) => ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
	const h1 = hue(a1p, b1);
	const h2 = hue(a2p, b2);
	let dh = h2 - h1;
	if (c1 * c2 === 0) dh = 0;
	else if (dh > 180) dh -= 360;
	else if (dh < -180) dh += 360;
	const dl = l2 - l1;
	const dc = c2 - c1;
	const dH = 2 * Math.sqrt(c1 * c2) * Math.sin(radians(dh / 2));
	const meanL = (l1 + l2) / 2;
	const meanC = (c1 + c2) / 2;
	let meanH = h1 + h2;
	if (c1 * c2 !== 0)
		meanH = Math.abs(h1 - h2) <= 180 ? meanH / 2 : (meanH + (meanH < 360 ? 360 : -360)) / 2;
	const t =
		1 -
		0.17 * Math.cos(radians(meanH - 30)) +
		0.24 * Math.cos(radians(2 * meanH)) +
		0.32 * Math.cos(radians(3 * meanH + 6)) -
		0.2 * Math.cos(radians(4 * meanH - 63));
	const theta = 30 * Math.exp(-(((meanH - 275) / 25) ** 2));
	const rc = 2 * Math.sqrt(meanC ** 7 / (meanC ** 7 + 25 ** 7));
	const sl = 1 + (0.015 * (meanL - 50) ** 2) / Math.sqrt(20 + (meanL - 50) ** 2);
	const sc = 1 + 0.045 * meanC;
	const sh = 1 + 0.015 * meanC * t;
	const rt = -Math.sin(radians(2 * theta)) * rc;
	return Math.sqrt((dl / sl) ** 2 + (dc / sc) ** 2 + (dH / sh) ** 2 + rt * (dc / sc) * (dH / sh));
}
