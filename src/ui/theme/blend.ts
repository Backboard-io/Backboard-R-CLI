// Fake alpha by compositing a color over an opaque background into one hex.

const parseHex = (hex: string): [number, number, number] => {
	const n = parseInt(hex.replace("#", ""), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const toHex = (v: number): string =>
	Math.max(0, Math.min(255, Math.round(v)))
		.toString(16)
		.padStart(2, "0");

/** Composite `fg` over `bg` at `alpha` (0–1) → opaque "#rrggbb". */
export function blend(fg: string, bg: string, alpha: number): string {
	const [fr, fg_, fb] = parseHex(fg);
	const [br, bg_, bb] = parseHex(bg);
	const mix = (f: number, b: number) => f * alpha + b * (1 - alpha);
	return `#${toHex(mix(fr, br))}${toHex(mix(fg_, bg_))}${toHex(mix(fb, bb))}`;
}

/** True if `hex` is a light color (relative luminance > 0.5). */
export function isLight(hex: string): boolean {
	const [r, g, b] = parseHex(hex);
	return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5;
}

/** Mix `p` (0–1) of white into `hex`. */
export const lighten = (hex: string, p: number): string =>
	blend("#ffffff", hex, p);

/** Mix `p` (0–1) of black into `hex`. */
export const darken = (hex: string, p: number): string =>
	blend("#000000", hex, p);

/** Elevation surface: lighten a dark bg, darken a light bg, by `p`. */
export function elevate(bg: string, p: number): string {
	return isLight(bg) ? darken(bg, p) : lighten(bg, p);
}
