import { parsePermissionMode } from "./PermissionMode.ts";
import { parseRuleSet } from "./PermissionRules.ts";
import { loadPermissionSettings } from "./settings.ts";
import type { PermissionContext } from "./types.ts";

export {
	isKnownPermissionMode,
	nextPermissionMode,
	PERMISSION_MODES,
	type PermissionMode,
	parsePermissionMode,
	permissionModeLabel,
} from "./PermissionMode.ts";
export type { PermissionContext } from "./types.ts";

/** Flag > settings mode > "manual". Rules come from .backboard/settings.json. */
export function buildPermissionContext(
	cwd: string,
	flagMode: string | undefined,
	interactive: boolean,
): PermissionContext {
	const settings = loadPermissionSettings(cwd);
	return {
		mode: parsePermissionMode(flagMode ?? settings.mode),
		rules: parseRuleSet(settings),
		interactive,
	};
}
