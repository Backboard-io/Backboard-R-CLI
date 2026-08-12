import { resolve } from "node:path";
import type { Tool } from "../tools/Tool.ts";
import { findMatch, type PermissionRule } from "./PermissionRules.ts";
import type { PermissionContext } from "./types.ts";

export type EngineDecision =
	| { behavior: "allow"; reason: string }
	| { behavior: "deny"; reason: string }
	| { behavior: "ask"; content?: string };

function normalizedPathRules(
	rules: PermissionRule[],
	cwd: string,
): PermissionRule[] {
	return rules.map((rule) => {
		if (!rule.pattern || rule.pattern.startsWith("=")) return rule;
		return { ...rule, pattern: resolve(cwd, rule.pattern) };
	});
}

/**
 * The permission pipeline. First match wins:
 * deny rule → ask rule → tool verdict → read-only → bypass → allow rule → ask.
 * Deny/ask rules sit above the bypass gate on purpose: no mode can skip them.
 *
 * Manual mode prompts for reads too, but only where a human can answer: a
 * sub-agent or headless run has no prompt, so an "ask" there is a hard denial.
 * Those keep the read-only shortcut instead of failing every Read and Grep.
 */
export function decidePermission(
	tool: Tool,
	input: unknown,
	pctx: PermissionContext,
	cwd: string,
): EngineDecision {
	const content = tool.permissionContent(input);
	const rawPaths = tool.permissionPaths(input);
	const paths = rawPaths?.map((path) => resolve(cwd, path));
	const denyRules = paths
		? normalizedPathRules(pctx.rules.deny, cwd)
		: pctx.rules.deny;
	const askRules = paths
		? normalizedPathRules(pctx.rules.ask, cwd)
		: pctx.rules.ask;
	const allowRules = paths
		? normalizedPathRules(pctx.rules.allow, cwd)
		: pctx.rules.allow;
	const name = tool.agentName;
	const strictManual = pctx.mode === "manual" && pctx.interactive;

	const denyRule = findMatch(denyRules, name, content, paths);
	if (denyRule) {
		return {
			behavior: "deny",
			reason: `Denied by permission rule "${denyRule.raw}"`,
		};
	}

	const askRule = findMatch(askRules, name, content, paths);
	if (askRule) {
		return content === undefined
			? { behavior: "ask" }
			: { behavior: "ask", content };
	}

	const verdict = tool.checkPermissions(input, {
		mode: pctx.mode,
		cwd,
		interactive: pctx.interactive,
	});
	if (verdict) return verdict;

	if (!strictManual && tool.isReadOnly(input)) {
		return { behavior: "allow", reason: "read-only tool" };
	}

	if (pctx.mode === "bypass") {
		return { behavior: "allow", reason: "bypass mode" };
	}

	const allowRule = findMatch(allowRules, name, content, paths, true);
	if (allowRule) {
		return {
			behavior: "allow",
			reason: `Allowed by permission rule "${allowRule.raw}"`,
		};
	}

	return content === undefined
		? { behavior: "ask" }
		: { behavior: "ask", content };
}
