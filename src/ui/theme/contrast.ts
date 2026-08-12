type Rgb = readonly [number, number, number];

const ANSI_HEX = {
	gray: "#808080",
} as const;

export type ContrastColor = keyof typeof ANSI_HEX;

export function readableAnsiOrForeground(
	color: ContrastColor,
	background: string | readonly string[],
	minContrast: number,
): string | undefined {
	const backgrounds = Array.isArray(background) ? background : [background];
	return backgrounds.every(
		(candidate) => contrastRatio(ANSI_HEX[color], candidate) >= minContrast,
	)
		? color
		: undefined;
}

export function contrastRatio(foreground: string, background: string): number {
	const lighter = Math.max(
		relativeLuminance(foreground),
		relativeLuminance(background),
	);
	const darker = Math.min(
		relativeLuminance(foreground),
		relativeLuminance(background),
	);
	return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(hex: string): number {
	const [red, green, blue] = parseHex(hex);
	const r = linearizeColorChannel(red);
	const g = linearizeColorChannel(green);
	const b = linearizeColorChannel(blue);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function linearizeColorChannel(channel: number): number {
	const srgb = channel / 255;
	return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function parseHex(hex: string): Rgb {
	const value = hex.replace("#", "");
	const normalized =
		value.length === 3
			? `${value[0]}${value[0]}${value[1]}${value[1]}${value[2]}${value[2]}`
			: value;
	const parsed = parseInt(normalized, 16);
	return [(parsed >> 16) & 255, (parsed >> 8) & 255, parsed & 255];
}
