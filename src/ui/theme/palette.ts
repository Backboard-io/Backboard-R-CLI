// Colors come from ANSI names (theme.ts); only the detection-fallback bg is RGB.
export const palette = {
	bg: "#05070B",
} as const;

export type PaletteColor = keyof typeof palette;
