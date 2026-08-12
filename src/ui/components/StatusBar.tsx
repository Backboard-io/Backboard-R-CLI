import { Box, Text } from "ink";
import type React from "react";
import type { ThinkingConfig, ThinkingIntent } from "../../config/defaults.ts";
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
}

export function StatusBar({
	model,
	thinking,
	permissionMode,
}: Props): React.ReactElement {
	const thinkingAmount = formatThinkingAmount(thinking);
	const uiTheme = useTheme();
	const secondary = uiTheme.readableSecondaryText;
	// Every mode gets a leading glyph: ⏸ for manual (pauses to ask you), ⏵⏵ for
	// the auto-approving modes. Each mode has its own color so they read apart.
	const { symbol, color } = permissionModeStyle(permissionMode, secondary);
	const modeDisplay = `${symbol} ${permissionModeLabel(permissionMode)} mode`;
	return (
		<Box marginTop={1}>
			<Text color={color} bold={permissionMode !== "manual"}>
				{modeDisplay}
			</Text>
			<Text color={secondary}>{STATUS_BAR_SEPARATOR}(shift+tab to cycle)</Text>
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
		</Box>
	);
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
		if (thinking.kind === "dynamic") return "dynamic";
		return thinking.level === "max" ? "xhigh" : thinking.level;
	}
	if ("effort" in thinking) {
		return thinking.effort === "max" ? "xhigh" : thinking.effort;
	}
	if ("budget_tokens" in thinking) return `${thinking.budget_tokens} tokens`;
	if ("max_tokens" in thinking) return `${thinking.max_tokens} tokens`;
	return null;
}
