import { Box, Text } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import type { ThinkingConfig, ThinkingIntent } from "../../config/defaults.ts";
import type { BackgroundRunSnapshot } from "../../core/bus/events.ts";
import {
	type PermissionMode,
	permissionModeLabel,
} from "../../core/permissions/PermissionMode.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { theme } from "../theme/theme.ts";

const STATUS_BAR_SEPARATOR = " · ";

interface Props {
	model: string;
	thinking: ThinkingConfig | ThinkingIntent | null | undefined;
	permissionMode: PermissionMode;
	backgroundAgents?: readonly BackgroundRunSnapshot[];
}

export function StatusBar({
	model,
	thinking,
	permissionMode,
	backgroundAgents = [],
}: Props): React.ReactElement {
	const thinkingAmount = formatThinkingAmount(thinking);
	const now = useTicker(backgroundAgents.length > 0);
	const uiTheme = useTheme();
	const secondary = uiTheme.readableSecondaryText;
	// Every mode gets a leading glyph: ⏸ for manual (pauses to ask you), ⏵⏵ for
	// the auto-approving modes. Each mode has its own color so they read apart.
	const { symbol, color } = permissionModeStyle(permissionMode, secondary);
	const modeDisplay = `${symbol} ${permissionModeLabel(permissionMode)} mode`;
	return (
		<Box marginTop={1} flexDirection="column">
			<Box>
				<Text color={color} bold={permissionMode !== "manual"}>
					{modeDisplay}
				</Text>
				<Text color={secondary}>
					{STATUS_BAR_SEPARATOR}(shift+tab to cycle)
				</Text>
				<Text color={secondary}>
					{STATUS_BAR_SEPARATOR}
					{model}
				</Text>
				{thinkingAmount ? (
					<Text color={secondary}>
						{STATUS_BAR_SEPARATOR}
						{thinkingAmount}
					</Text>
				) : null}
				{backgroundAgents.length > 0 ? (
					<Text color={theme.accentBright}>
						{STATUS_BAR_SEPARATOR}
						{formatBackgroundSummary(backgroundAgents)}
					</Text>
				) : null}
			</Box>
			{backgroundAgents.map((run) => (
				<Text key={run.id} color={secondary}>
					{`  ↳ ${run.agent}  ${formatElapsed(run.startedAt, now)}  ${run.label}`}
				</Text>
			))}
		</Box>
	);
}

function useTicker(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [active]);
	return now;
}

export function formatBackgroundSummary(
	runs: readonly BackgroundRunSnapshot[],
): string {
	return `${runs.length} agent${runs.length === 1 ? "" : "s"} running`;
}

export function formatElapsed(startedAt: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60)
		return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function permissionModeStyle(
	mode: PermissionMode,
	manualColor: string | undefined,
): { symbol: string; color: string | undefined } {
	switch (mode) {
		case "acceptEdits":
			return { symbol: "◆", color: theme.success };
		case "auto":
			// Match the mascot fill so Auto reads as the "house" AI mode.
			return { symbol: "✦", color: theme.accentBright };
		case "bypass":
			return { symbol: "»", color: theme.error };
		default:
			return { symbol: "⏸", color: manualColor };
	}
}

export function formatThinkingAmount(
	thinking: ThinkingConfig | ThinkingIntent | null | undefined,
): string | null {
	if (!thinking || Object.keys(thinking).length === 0) return null;
	if ("kind" in thinking) {
		if (thinking.kind === "budget") return `${thinking.tokens} tokens`;
		return thinking.level === "max" ? "xhigh" : thinking.level;
	}
	if ("effort" in thinking) {
		return thinking.effort === "max" ? "xhigh" : thinking.effort;
	}
	if ("budget_tokens" in thinking) return `${thinking.budget_tokens} tokens`;
	if ("max_tokens" in thinking) return `${thinking.max_tokens} tokens`;
	return null;
}
