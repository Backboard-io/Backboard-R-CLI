import { Box, Text, useAnimation } from "ink";
import type React from "react";
import { theme } from "../theme/theme.ts";
import { ASSISTANT_OUTPUT_MARKER } from "./MessageLayout.constants.ts";
import { SPINNER_SHADOW_INTERVAL_MS } from "./Spinner.constants.ts";
import type {
	ShadowedTextProps,
	SpinnerProps,
	SpinnerShadowTone,
} from "./Spinner.types.ts";
import {
	formatSpinnerMeta,
	spinnerSegmentDisplayText,
	spinnerShadowRange,
	spinnerTextSegments,
} from "./SpinnerFormatting.ts";

export function Spinner({
	label = "Working",
	showElapsed = false,
	showInterruptHint = false,
	showResultMarker = false,
}: SpinnerProps): React.ReactElement {
	const { frame, time } = useAnimation({
		interval: SPINNER_SHADOW_INTERVAL_MS,
	});
	const shadowText = showResultMarker
		? `${ASSISTANT_OUTPUT_MARKER}${label}`
		: label;
	const shadowRange = spinnerShadowRange(shadowText, frame);
	const metaText = formatSpinnerMeta(
		showElapsed ? time : null,
		showInterruptHint,
	);

	const loader = (
		<Box>
			<ShadowedText
				text={label}
				positionOffset={showResultMarker ? 1 : 0}
				shadowRange={shadowRange}
				bold
			/>
			{metaText ? <Text color={theme.spinnerMeta}> {metaText}</Text> : null}
		</Box>
	);

	if (!showResultMarker) return loader;
	return (
		<Box>
			<ShadowedText text={ASSISTANT_OUTPUT_MARKER} shadowRange={shadowRange} />
			<Box marginLeft={1}>{loader}</Box>
		</Box>
	);
}

export function ShadowedText({
	text,
	positionOffset = 0,
	shadowRange,
	bold = false,
}: ShadowedTextProps): React.ReactElement {
	const segments = spinnerTextSegments(text, positionOffset, shadowRange);
	return (
		<Text>
			{segments.map((segment) => (
				<Text
					key={`${segment.start}:${segment.tone}`}
					color={spinnerToneColor(segment.tone)}
					bold={bold}
				>
					{spinnerSegmentDisplayText(segment)}
				</Text>
			))}
		</Text>
	);
}

function spinnerToneColor(tone: SpinnerShadowTone): string {
	switch (tone) {
		case "shadowTrail":
			return theme.spinnerHighlightTrail;
		case "shadowCore":
			return theme.spinnerHighlightCore;
		case "shadowLead":
			return theme.spinnerHighlightLead;
		case "normal":
			return theme.spinner;
	}
}
