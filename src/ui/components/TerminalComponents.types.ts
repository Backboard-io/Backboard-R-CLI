import type { StartupUpdateInfo } from "../../core/update/startupNotice.ts";

export type ShellPromptState = "default" | "active";

export interface ShellPromptProps {
	state?: ShellPromptState;
	user?: string;
	path?: string;
	version?: string;
	time?: string;
}

export interface ShellPromptLayoutInput {
	columns: number;
	user: string;
	path: string;
	version: string;
	time?: string;
}

export interface ShellPromptLayout {
	user?: string;
	path: string;
	version?: string;
	time?: string;
}

export type SessionCardType = "authenticated" | "noAuth";

export interface SessionCardProps {
	type?: SessionCardType;
	workspace?: string;
	status?: string;
	model?: string;
	context?: string;
	/** When set, the card shows a "new version available" row pointing at /update. */
	update?: StartupUpdateInfo | null;
}

export type AuthPromptSelection = "login" | "byok" | "exit";

export interface AuthPromptProps {
	selected?: AuthPromptSelection;
	columns: number;
}
