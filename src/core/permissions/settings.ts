import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { qProjectConfigDir } from "../../config/paths.ts";
import {
	PERMISSION_MODES,
	type PermissionMode,
	parsePermissionMode,
} from "./PermissionMode.ts";

export const SETTINGS_FILE_NAME = "settings.json";

export interface PermissionSettings {
	mode?: PermissionMode;
	allow: string[];
	deny: string[];
	ask: string[];
	warnings?: string[];
}

function settingsPath(cwd: string): string {
	return path.join(qProjectConfigDir(cwd), SETTINGS_FILE_NAME);
}

function readSettingsFile(cwd: string): Record<string, unknown> {
	try {
		const raw = readFileSync(settingsPath(cwd), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// Missing or corrupt file: fall through to empty settings. Never crash.
	}
	return {};
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

export function loadPermissionSettings(cwd: string): PermissionSettings {
	const file = readSettingsFile(cwd);
	const block = file.permissions;
	if (!block || typeof block !== "object" || Array.isArray(block)) {
		return { allow: [], deny: [], ask: [] };
	}
	const record = block as Record<string, unknown>;
	const settings: PermissionSettings = {
		allow: stringArray(record.allow),
		deny: stringArray(record.deny),
		ask: stringArray(record.ask),
	};
	if (record.mode !== undefined) {
		if (
			typeof record.mode === "string" &&
			(PERMISSION_MODES as readonly string[]).includes(record.mode)
		) {
			settings.mode = parsePermissionMode(record.mode);
		} else {
			settings.mode = "manual";
			settings.warnings = [
				`Unknown permissions.mode in ${settingsPath(cwd)}; using manual mode. Valid: ${PERMISSION_MODES.join(", ")}.`,
			];
		}
	}
	return settings;
}

export function appendAllowRule(cwd: string, rule: string): void {
	const file = readSettingsFile(cwd);
	const block =
		file.permissions &&
		typeof file.permissions === "object" &&
		!Array.isArray(file.permissions)
			? (file.permissions as Record<string, unknown>)
			: {};
	const allow = stringArray(block.allow);
	if (!allow.includes(rule)) allow.push(rule);
	file.permissions = { ...block, allow };
	try {
		const dest = settingsPath(cwd);
		mkdirSync(path.dirname(dest), { recursive: true });
		// temp-write + atomic rename: no torn file on a partial/concurrent write.
		const tmp = `${dest}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(file, null, "\t")}\n`);
		renameSync(tmp, dest);
	} catch {
		// Best-effort persistence: the in-memory session rule (applied by the
		// caller before this runs) already covers the current turn. Never let
		// a read-only fs, permissions, or disk-full error crash the scheduler
		// round after the user has granted permission.
	}
}
