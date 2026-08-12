import { Box } from "ink";
import type React from "react";
import { APP_VERSION } from "../../config/branding.ts";
import type { UsageInfo } from "../../core/bus/events.ts";
import { formatTokens } from "../../core/context/tokens.ts";
import type { StartupUpdateInfo } from "../../core/update/startupNotice.ts";
import type { RunStatus } from "../../state/AppState.ts";
import { shellPathLabel } from "../utils/pathLabels.ts";
import { SessionCard } from "./SessionCard.tsx";
import { ShellPrompt } from "./ShellPrompt.tsx";

interface Props {
	status: RunStatus;
	model: string;
	cwd: string;
	usage: UsageInfo;
	update?: StartupUpdateInfo | null;
}

const CONTEXT_LIMIT = 1_000_000;

export function Banner({
	status,
	model,
	cwd,
	usage,
	update,
}: Props): React.ReactElement {
	return (
		<Box flexDirection="column">
			<Box paddingX={1}>
				<ShellPrompt
					state="default"
					user={process.env.USER ?? "backboard"}
					path={shellPathLabel(cwd)}
					version={`v${APP_VERSION}`}
				/>
			</Box>
			<Box paddingX={1} marginTop={1}>
				<SessionCard
					workspace={workspaceLabel(cwd)}
					model={model}
					context={contextLabel(usage)}
					status={statusLabel(status)}
					update={update}
				/>
			</Box>
		</Box>
	);
}

function contextLabel(usage: UsageInfo): string {
	const tokens = usage.contextTokens ?? usage.totalTokens ?? 0;
	const limit = usage.contextLimit ?? CONTEXT_LIMIT;
	return `${tokens.toLocaleString()} / ${formatTokens(limit)}`;
}

function workspaceLabel(cwd: string): string {
	const parts = cwd.split("/").filter(Boolean);
	const repo = parts.at(-1);
	const owner = parts.at(-2);
	if (!repo) return cwd;
	return owner ? `${owner}/${repo}` : repo;
}

function statusLabel(status: RunStatus): string {
	switch (status) {
		case "running":
			return "Thinking";
		case "cancelled":
			return "Cancelled";
		default:
			return "Synced";
	}
}
