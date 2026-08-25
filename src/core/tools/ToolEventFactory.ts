import type { AgentEvent, ToolCallRef } from "../bus/events.ts";
import { requireAgentToolOutput } from "./AgentToolOutputGuard.ts";
import { clampSummary, genericInputSummary } from "./inputSummary.ts";
import type { Tool } from "./Tool.ts";
import type { ToolResultDetailLine } from "./ToolResultDetail.ts";

export function toolStartEvent(
	ref: ToolCallRef,
	input: unknown,
	tool?: Tool,
): AgentEvent {
	const inputSummary = summarizeToolInput(input, tool);
	const name = tool?.displayName ?? ref.name;
	const agentMode =
		tool?.agentName === "agent"
			? (tool.agentModeForInput(input) ?? agentModeFromInput(input))
			: undefined;
	return {
		type: "tool:start",
		toolCallId: ref.id,
		name,
		inputSummary,
		...(agentMode ? { agentMode } : {}),
	};
}

export function toolPendingEvent(
	toolCallId: string,
	displayName: string,
	input?: unknown,
	tool?: Tool,
): AgentEvent {
	return {
		type: "tool:pending",
		toolCallId,
		name: displayName,
		inputSummary: summarizeToolInput(input, tool),
	};
}

export function toolErrorStartEvent(
	ref: ToolCallRef,
	displayName: string | undefined,
	tool?: Tool,
): AgentEvent {
	return {
		type: "tool:start",
		toolCallId: ref.id,
		name: displayName ?? ref.name,
		inputSummary: summarizeToolInput(ref.input, tool),
	};
}

function agentModeFromInput(input: unknown): "worker" | "rlm" | undefined {
	if (!input || typeof input !== "object") return "worker";
	const value = (input as { subagent_type?: unknown }).subagent_type;
	return value === "rlm" || value === "worker" ? value : "worker";
}

export function toolResultEvent(
	ref: ToolCallRef,
	tool: Tool,
	output: unknown,
	title: string,
	detail?: string,
	detailLines?: ToolResultDetailLine[],
): AgentEvent {
	const name = tool.displayName;
	if (tool.agentName === "agent") {
		return {
			type: "tool:result",
			toolCallId: ref.id,
			name,
			title,
			...(detail ? { detail } : {}),
			...(detailLines ? { detailLines } : {}),
			agentOutput: requireAgentToolOutput(output),
		};
	}
	return {
		type: "tool:result",
		toolCallId: ref.id,
		name,
		title,
		...(detail ? { detail } : {}),
		...(detailLines ? { detailLines } : {}),
	};
}

/**
 * The one-line parameter summary shown beneath a tool's name. Each tool owns the
 * parameters that explain its own calls via `Tool.summarizeInput()` (so renaming
 * a tool param can't silently degrade its summary from afar); tools that don't
 * override fall back to a tool-agnostic free-form field. The result is clamped
 * to one readable line here so every tool gets consistent length handling.
 */
export function summarizeToolInput(input: unknown, tool?: Tool): string {
	if (!input || typeof input !== "object") return "";
	const custom = tool?.summarizeInput(input);
	if (custom) return clampSummary(custom);
	return clampSummary(genericInputSummary(input));
}
