export type RuleBehavior = "allow" | "deny" | "ask";

export interface PermissionRule {
	behavior: RuleBehavior;
	/** Lower-cased Tool.agentName, e.g. "execute". */
	toolName: string;
	/** Content pattern: exact string, "prefix:*", or a path glob. Absent = whole tool. */
	pattern?: string;
	/** Original rule string as written in settings. */
	raw: string;
}

export interface RuleSet {
	allow: PermissionRule[];
	deny: PermissionRule[];
	ask: PermissionRule[];
}

export function emptyRuleSet(): RuleSet {
	return { allow: [], deny: [], ask: [] };
}

const RULE_RE = /^([a-zA-Z_][\w-]*)(?:\((.+)\))?$/;

export function parseRule(
	raw: string,
	behavior: RuleBehavior,
): PermissionRule | null {
	const match = raw.trim().match(RULE_RE);
	if (!match?.[1]) return null;
	const toolName = match[1].toLowerCase();
	const pattern = match[2]?.trim();
	return pattern
		? { behavior, toolName, pattern, raw: raw.trim() }
		: { behavior, toolName, raw: raw.trim() };
}

export function parseRuleSet(input: {
	allow?: string[];
	deny?: string[];
	ask?: string[];
}): RuleSet {
	const parse = (rules: string[] | undefined, behavior: RuleBehavior) =>
		(rules ?? [])
			.map((raw) => parseRule(raw, behavior))
			.filter((rule): rule is PermissionRule => rule !== null);
	return {
		allow: parse(input.allow, "allow"),
		deny: parse(input.deny, "deny"),
		ask: parse(input.ask, "ask"),
	};
}

function patternMatches(pattern: string, content: string): boolean {
	if (pattern.startsWith("=")) {
		return content === pattern.slice(1);
	}
	if (pattern.endsWith(":*")) {
		const prefix = pattern.slice(0, -2);
		return content === prefix || content.startsWith(`${prefix} `);
	}
	if (pattern.includes("*")) {
		return new Bun.Glob(pattern).match(content);
	}
	return content === pattern;
}

export function findMatch(
	rules: PermissionRule[],
	toolName: string,
	content: string | undefined,
	paths?: readonly string[],
	requireAllPaths = false,
): PermissionRule | null {
	const name = toolName.toLowerCase();
	if (requireAllPaths && paths !== undefined && paths.length > 0) {
		const toolRules = rules.filter((rule) => rule.toolName === name);
		const bare = toolRules.find((rule) => !rule.pattern);
		if (bare) return bare;
		const exact = toolRules.find(
			(rule) =>
				rule.pattern?.startsWith("=") &&
				content !== undefined &&
				patternMatches(rule.pattern, content),
		);
		if (exact) return exact;
		const pathRules = toolRules.filter(
			(rule): rule is PermissionRule & { pattern: string } =>
				rule.pattern !== undefined && !rule.pattern.startsWith("="),
		);
		if (
			paths.every((path) =>
				pathRules.some((rule) => patternMatches(rule.pattern, path)),
			)
		) {
			return (
				pathRules.find((rule) =>
					paths.some((path) => patternMatches(rule.pattern, path)),
				) ?? null
			);
		}
		return null;
	}
	for (const rule of rules) {
		if (rule.toolName !== name) continue;
		if (!rule.pattern) return rule;
		const pattern = rule.pattern;
		if (paths !== undefined && !pattern.startsWith("=") && paths.length > 0) {
			const matches = paths.map((path) => patternMatches(pattern, path));
			if (matches.some(Boolean)) return rule;
			continue;
		}
		if (content !== undefined && patternMatches(pattern, content)) {
			return rule;
		}
	}
	return null;
}
