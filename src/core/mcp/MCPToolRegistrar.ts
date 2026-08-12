import { McpToolAdapter } from "../../tools/MCPToolAdapter.tsx";
import type { EventBus } from "../bus/EventBus.ts";
import type { ToolRegistry } from "../tools/ToolRegistry.ts";
import type {
	McpInitializeResult,
	McpServerMutationResult,
	McpToolRefreshResult,
} from "./MCPTypes.ts";

interface McpToolRegistrationResult {
	toolNames: string[];
	warnings: string[];
}

export class McpToolRegistrar {
	constructor(
		private readonly registry: ToolRegistry,
		private readonly bus: EventBus,
	) {}

	register(result: McpInitializeResult): McpToolRegistrationResult {
		const toolNames: string[] = [];
		for (const tool of result.tools) {
			const adapter = new McpToolAdapter(tool);
			this.registry.register(adapter);
			toolNames.push(adapter.name);
		}
		this.emitWarnings(result.warnings);
		return { toolNames, warnings: [...result.warnings] };
	}

	unregister(result: McpServerMutationResult): McpToolRegistrationResult {
		for (const toolName of result.toolNames) {
			this.registry.unregister(toolName);
		}
		this.emitWarnings(result.warnings);
		return { toolNames: [...result.toolNames], warnings: [...result.warnings] };
	}

	applyRefresh(result: McpToolRefreshResult): McpToolRegistrationResult {
		this.unregister({ toolNames: result.removedToolNames, warnings: [] });
		return this.register({
			tools: result.tools,
			warnings: result.warnings,
		});
	}

	emitWarnings(warnings: readonly string[]): void {
		for (const warning of warnings) {
			this.bus.emit({ type: "system:warning", message: warning });
		}
	}
}
