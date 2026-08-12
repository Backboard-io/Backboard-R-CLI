import { blend, elevate } from "./blend.ts";
import { readableAnsiOrForeground } from "./contrast.ts";
import { palette } from "./palette.ts";

// Foreground/borders use ANSI names (respect the terminal theme); surfaces are
// elevation steps computed from the detected terminal background.

const FG = undefined; // terminal default foreground
const SECONDARY_TEXT_MIN_CONTRAST = 4.5;

function surfacesFor(bg: string): {
	surface1: string;
	surface2: string;
	surface3: string;
} {
	return {
		surface1: elevate(bg, 0.04),
		surface2: elevate(bg, 0.08),
		surface3: elevate(bg, 0.12),
	};
}

export function createTheme(bg: string = palette.bg) {
	const surfaces = surfacesFor(bg);
	const readableSecondaryText = readableAnsiOrForeground(
		"gray",
		[bg, surfaces.surface1],
		SECONDARY_TEXT_MIN_CONTRAST,
	);
	return {
		// text/inputText are deliberately undefined: render in the terminal's
		// default foreground color.
		text: FG,
		inputText: FG,
		accentBright: "cyan",
		toolRunning: "cyan",
		spinner: "cyan",
		readableSecondaryText,
		subtle: readableSecondaryText,
		subtleDecoration: "gray",
		spinnerMeta: "gray",
		border: "gray",
		inputPlaceholder: "gray",
		inputBackground: "black",
		success: "green",
		toolDone: "green",
		error: "red",
		toolError: "red",
		warning: "yellow",
		spinnerHighlightTrail: "blue",
		spinnerHighlightCore: "cyan",
		spinnerHighlightLead: "cyanBright",

		inputSurfaceBackground: surfaces.surface1,
		highlightBackground: surfaces.surface3,
		// Diff row tints composited over the detected terminal background so
		// they stay legible on light terminals too.
		diffAddedBackground: blend("#2ea043", bg, 0.35),
		diffRemovedBackground: blend("#f85149", bg, 0.28),
	} as const;
}

export const defaultTheme = createTheme();

export type Theme = typeof defaultTheme;

export let theme: Theme = defaultTheme;

export function setTheme(value: Theme): void {
	theme = value;
}
