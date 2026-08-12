export type ThinkingLevel = "low" | "medium" | "high" | "max";

export type ThinkingIntent =
	| { kind: "level"; level: ThinkingLevel }
	| { kind: "budget"; tokens: number }
	| { kind: "dynamic" };

export type ThinkingConfig =
	| { effort: ThinkingLevel }
	| { budget_tokens: number }
	| { max_tokens: number }
	| Record<string, never>;

export interface ThinkingControlsMetadata {
	supported: boolean;
	allowed_fields: string[];
	defaults_only: boolean;
}

export interface ThinkingModelMetadata {
	provider: string;
	model: string;
	max_output_tokens?: number | null;
	supports_thinking?: boolean | null;
	thinking_controls?: ThinkingControlsMetadata | null;
}

export type ThinkingRequestField = "effort" | "budget_tokens" | "max_tokens";

export type ThinkingRequestKind = "user" | "subagent";
export type ThinkingRequestPhase = "initial" | "tool_outputs";

export interface ToolRoundThinkingEvidence {
	index: number;
	readOnlyOnly: boolean;
	hadWriteOrExecute: boolean;
	hadToolError: boolean;
	hadNonZeroExit: boolean;
	hadTimeout: boolean;
	consecutiveFailureCount: number;
	maxUsed: boolean;
}

export interface DynamicThinkingEvidence {
	phase: ThinkingRequestPhase;
	requestKind: ThinkingRequestKind;
	hasDiagnosticText?: boolean;
	toolRound?: ToolRoundThinkingEvidence;
}

export interface ThinkingResolveContext {
	intent: ThinkingIntent | null | undefined;
	model: {
		provider: string;
		model: string;
	};
	metadata?: ThinkingModelMetadata | null;
	dynamicEvidence?: DynamicThinkingEvidence;
}
