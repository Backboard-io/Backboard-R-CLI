import type { McpServerRuntimeStatus } from "../../core/mcp/index.ts";
import { theme } from "../theme/theme.ts";

export function mcpStatusLabel(
	status: McpServerRuntimeStatus["status"],
): string {
	switch (status) {
		case "connected":
			return "connected";
		case "needs_authentication":
			return "needs auth";
		case "disabled":
			return "disabled";
		case "error":
			return "error";
	}
}

export function mcpStatusColor(
	status: McpServerRuntimeStatus["status"],
): string | undefined {
	switch (status) {
		case "connected":
			return theme.success;
		case "needs_authentication":
			return theme.warning;
		case "disabled":
			return theme.subtle;
		case "error":
			return theme.error;
	}
}
