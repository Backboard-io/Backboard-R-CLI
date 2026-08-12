export interface SpinnerProps {
	label?: string;
	showElapsed?: boolean;
	showInterruptHint?: boolean;
	showResultMarker?: boolean;
}

export interface ShadowedTextProps {
	text: string;
	positionOffset?: number;
	shadowRange: SpinnerShadowRange | null;
	bold?: boolean;
}

export interface SpinnerShadowRange {
	start: number;
	end: number;
}

export type SpinnerShadowTone =
	| "normal"
	| "shadowTrail"
	| "shadowCore"
	| "shadowLead";

export interface SpinnerTextSegment {
	start: number;
	text: string;
	tone: SpinnerShadowTone;
}
