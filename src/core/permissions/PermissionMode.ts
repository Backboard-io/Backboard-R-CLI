/**
 * All permission modes. `auto` allows workspace edits, network reads, and any
 * command off the danger list (see dangerousCommands.ts); dangerous commands
 * and outward-facing tools (browser, computer, mutating MCP) still prompt.
 */
export const PERMISSION_MODES = [
	"manual",
	"acceptEdits",
	"auto",
	"bypass",
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Modes reachable by Shift+Tab. `bypass` is flag-only (`--permission-mode`). */
const CYCLE_MODES = ["auto", "acceptEdits", "manual"] as const;

const LABELS: Record<PermissionMode, string> = {
	manual: "Manual",
	acceptEdits: "Accept Edits",
	auto: "Auto",
	bypass: "Bypass",
};

/** True when `value` is a real mode; use to reject typo'd CLI flags. */
export function isKnownPermissionMode(value: string | undefined): boolean {
	return (
		value !== undefined &&
		(PERMISSION_MODES as readonly string[]).includes(value)
	);
}

export function parsePermissionMode(value: string | undefined): PermissionMode {
	if (value === undefined) return "auto";
	return isKnownPermissionMode(value) ? (value as PermissionMode) : "manual";
}

export function nextPermissionMode(mode: PermissionMode): PermissionMode {
	// From bypass (not in the cycle) this exits to the top rather than looping.
	const index = (CYCLE_MODES as readonly string[]).indexOf(mode);
	if (index === -1) return CYCLE_MODES[0];
	return CYCLE_MODES[(index + 1) % CYCLE_MODES.length] ?? CYCLE_MODES[0];
}

export function permissionModeLabel(mode: PermissionMode): string {
	return LABELS[mode];
}
