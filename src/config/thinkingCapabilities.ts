import {
	fallbackThinkingProfile,
	type ThinkingProfile,
} from "./thinking.profiles.ts";
import type {
	ThinkingModelMetadata,
	ThinkingRequestField,
} from "./thinking.types.ts";

export interface ThinkingCapabilityContext {
	model: {
		provider: string;
		model: string;
	};
	metadata?: ThinkingModelMetadata | null;
}

export interface ThinkingCapabilities {
	profile: ThinkingProfile | null;
	supportsThinking: boolean;
	defaultsOnly: boolean;
	allowedFields: ThinkingRequestField[];
}

export function resolveThinkingCapabilities(
	context: ThinkingCapabilityContext,
): ThinkingCapabilities {
	const profile = fallbackThinkingProfile(
		context.model.provider,
		context.model.model,
	);
	const controls = context.metadata?.thinking_controls;
	return {
		profile,
		supportsThinking: context.metadata?.supports_thinking !== false,
		defaultsOnly: controls?.defaults_only === true,
		allowedFields: allowedThinkingFields(
			context.metadata,
			profile?.fields ?? [],
		),
	};
}

export function tokenFieldFor(
	fields: readonly ThinkingRequestField[],
): "budget_tokens" | "max_tokens" | null {
	if (fields.includes("budget_tokens")) return "budget_tokens";
	if (fields.includes("max_tokens")) return "max_tokens";
	return null;
}

function allowedThinkingFields(
	metadata: ThinkingModelMetadata | null | undefined,
	fallbackFields: readonly ThinkingRequestField[],
): ThinkingRequestField[] {
	const fields = metadata?.thinking_controls?.allowed_fields;
	if (fields && fields.length > 0) {
		return fields.filter(isThinkingRequestField);
	}
	return [...fallbackFields];
}

function isThinkingRequestField(value: string): value is ThinkingRequestField {
	return (
		value === "effort" || value === "budget_tokens" || value === "max_tokens"
	);
}
