import { Box, Text, useAnimation } from "ink";
import type React from "react";
import type { AgentChildToolCall } from "../../core/bus/events.ts";
import type { ToolResultDetailLine } from "../../core/tools/ToolResultDetail.ts";
import { theme } from "../theme/theme.ts";
import { SPINNER_SHADOW_INTERVAL_MS } from "./Spinner.constants.ts";
import { ShadowedText } from "./Spinner.tsx";
import { spinnerShadowRange } from "./SpinnerFormatting.ts";
import { ToolResultView } from "./ToolResultView.tsx";

interface Props {
	name: string;
	inputSummary: string;
	status: "pending" | "running" | "done" | "error";
	agentMode?: "worker" | "rlm";
	childToolCalls?: AgentChildToolCall[];
	title?: string;
	detail?: string;
	detailLines?: ToolResultDetailLine[];
	error?: string;
}

type ToolStatus = Props["status"];

export const TOOL_STATUS_ICON: Record<ToolStatus, string> = {
	pending: " ",
	running: " ",
	done: " ",
	error: "✗",
};

// A function rather than a module-level record: a record would snapshot the
// theme at import time, before the terminal background has been detected.
export function toolStatusColor(status: ToolStatus): string {
	switch (status) {
		case "pending":
		case "running":
			return theme.toolRunning;
		case "done":
			return theme.toolDone;
		case "error":
			return theme.toolError;
	}
}

// A tool's whole body — parameters, metadata, title, detail — shares one muted
// tone; only the tool name and the ×N call count stand out. Keep the parameter
// line uniformly subtle so nothing under the header competes with it.
export function InputSummary({
	summary,
}: {
	summary: string;
}): React.ReactElement {
	return (
		<Text color={theme.subtle} wrap="truncate-end">
			{summary}
		</Text>
	);
}

export function ToolCallView({
	name,
	inputSummary,
	status,
	agentMode,
	childToolCalls = [],
	title,
	detail,
	detailLines,
	error,
}: Props): React.ReactElement {
	const { frame } = useAnimation({ interval: SPINNER_SHADOW_INTERVAL_MS });
	const agentLabel = agentMode ? `${name} (${agentMode})` : name;
	// The working-shadow wave runs from the moment a call is announced until
	// it finishes; the label then settles back to the plain accent color.
	const animated = status === "pending" || status === "running";
	const shadowRange = animated ? spinnerShadowRange(agentLabel, frame) : null;
	const latestChild = childToolCalls.at(-1);
	const showChildLine = status === "running" && latestChild;
	return (
		<Box flexDirection="column" marginTop={1}>
			<Box>
				<Text color={toolStatusColor(status)}>{TOOL_STATUS_ICON[status]} </Text>
				{shadowRange ? (
					<ShadowedText text={agentLabel} shadowRange={shadowRange} bold />
				) : (
					<Text color={theme.accentBright} bold>
						{agentLabel}
					</Text>
				)}
			</Box>
			{inputSummary ? (
				<Box marginLeft={3}>
					<InputSummary summary={inputSummary} />
				</Box>
			) : null}
			{showChildLine ? (
				<Box marginLeft={3}>
					<Text color={theme.subtle} wrap="truncate-end">
						↳{" "}
					</Text>
					<Text color={theme.accentBright} bold>
						{latestChild.name}
					</Text>
					<Text color={theme.subtle} wrap="truncate-end">
						{latestChild.inputSummary ? ` ${latestChild.inputSummary}` : ""}
					</Text>
				</Box>
			) : null}
			<Box marginLeft={1} flexDirection="column">
				<ToolResultView
					status={status}
					title={title}
					detail={detail}
					detailLines={detailLines}
					error={error}
				/>
			</Box>
		</Box>
	);
}
