import { z } from "zod";
import type {
	McpAddResult,
	McpRegistryItem,
	McpServerRuntimeStatus,
} from "../core/mcp/index.ts";
import type {
	PermissionCheckContext,
	PermissionDecision,
} from "../core/permissions/types.ts";
import { Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import { errorMessage } from "../utils/errors.ts";
import { keywordScore, tokenize } from "./discoveryMatch.ts";

/** Narrow view of McpController this tool needs (a getter, since it's built after the registry). */
export interface McpRegistrar {
	listServerStatuses(): McpServerRuntimeStatus[];
	listRegistryServers(signal?: AbortSignal): Promise<McpRegistryItem[]>;
	addRegistryServer(
		item: McpRegistryItem,
		signal?: AbortSignal,
	): Promise<McpAddResult>;
}

const schema = z.object({
	task: z
		.string()
		.min(1)
		.describe("A short description of what you're trying to do"),
	server: z
		.string()
		.optional()
		.describe("Add a specific MCP server by title or id instead of ranking"),
});

type Input = z.infer<typeof schema>;

interface Candidate {
	id: string;
	title: string;
	description: string;
	score: number;
	requiredEnv: string[];
}

interface Output {
	task: string;
	added?: string;
	toolNames?: string[];
	candidates: Candidate[];
}

const MAX_CANDIDATES = 6;

/** Ranks the MCP registry against the task, adds the best match behind a confirm gate. */
export class FindMcpTool extends Tool<Input, Output> {
	readonly name = "FindMcp";
	readonly inputSchema = schema;

	constructor(private readonly getController: () => McpRegistrar | undefined) {
		super();
	}

	override prompt(): string {
		return [
			"Find and connect an MCP server that gives you tools for the current task.",
			"Searches the curated MCP registry (matched by title and description) and,",
			"after asking the user for confirmation, adds and connects the best match,",
			"then reports the new tools it exposes.",
			"Pass `task` describing what you need; optionally pass `server` to add a",
			"specific server by title. Reach for this when the task needs an external",
			"integration (a database, an API, a SaaS product) you have no tool for.",
		].join(" ");
	}

	override isReadOnly(): boolean {
		return false;
	}

	override isConcurrencySafe(): boolean {
		return false;
	}

	override checkPermissions(
		_input: Input,
		ctx: PermissionCheckContext,
	): PermissionDecision | undefined {
		if (ctx.mode === "auto") {
			return { behavior: "allow", reason: "MCP discovery (auto mode)" };
		}
		return undefined;
	}

	override summarizeInput(input: Input): string | undefined {
		return input.server ? `add ${input.server}` : input.task;
	}

	override async execute(
		input: Input,
		ctx: ToolContext,
	): Promise<ToolResult<Output>> {
		const controller = this.getController();
		if (!controller) {
			return ok(
				{ task: input.task, candidates: [] },
				"MCP is not available in this session.",
				"MCP unavailable",
			);
		}

		let servers: McpRegistryItem[];
		try {
			servers = await controller.listRegistryServers(ctx.signal);
		} catch (err) {
			return ok(
				{ task: input.task, candidates: [] },
				`Could not load the MCP registry: ${errorMessage(err)}`,
				"Registry unavailable",
			);
		}

		const active = new Set(controller.listServerStatuses().map((s) => s.name));
		const available = servers.filter(
			(s) => !s.disabledReason && !active.has(s.id),
		);

		if (input.server) {
			return this.addNamed(input, servers, available, active, controller, ctx);
		}

		if (available.length === 0) {
			return ok(
				{ task: input.task, candidates: [] },
				"No MCP servers are available to add (all known servers are already connected or disabled).",
				"None available",
			);
		}

		const ranked = rankMcpServers(input.task, available);
		const best = ranked[0];
		if (!best || best.score <= 0) {
			return ok(
				{ task: input.task, candidates: ranked.slice(0, MAX_CANDIDATES) },
				`No MCP server clearly matches "${input.task}". Available servers:\n${listing(available)}\n\n` +
					'Add one explicitly with find_mcp({ server: "<title>" }).',
				"No clear match",
			);
		}

		const item = available.find((s) => s.id === best.id);
		if (!item) {
			return ok(
				{ task: input.task, candidates: ranked.slice(0, MAX_CANDIDATES) },
				`Ranked "${best.title}" but could not resolve it.`,
				"Resolution failed",
			);
		}
		return this.confirmAndAdd(input, item, controller, ctx);
	}

	private async addNamed(
		input: Input,
		servers: McpRegistryItem[],
		available: McpRegistryItem[],
		active: ReadonlySet<string>,
		controller: McpRegistrar,
		ctx: ToolContext,
	): Promise<ToolResult<Output>> {
		const target = input.server?.trim().toLowerCase();
		const matchesName = (s: McpRegistryItem) =>
			s.id.toLowerCase() === target || s.title.toLowerCase() === target;
		const item = available.find(matchesName);
		if (item) return this.confirmAndAdd(input, item, controller, ctx);

		// `available` excludes active and disabled servers, so a named server in
		// either state would otherwise report "not found". `active` holds registry ids.
		const connected = servers.find((s) => matchesName(s) && active.has(s.id));
		if (connected) {
			return ok(
				{ task: input.task, candidates: [] },
				`"${connected.title}" is already connected. Its tools are available now.`,
				"Already connected",
			);
		}

		const disabled = servers.find((s) => matchesName(s) && s.disabledReason);
		if (disabled) {
			return ok(
				{ task: input.task, candidates: [] },
				`"${disabled.title}" is unavailable: ${disabled.disabledReason}`,
				`"${input.server}" unavailable`,
			);
		}

		const names = available.map((s) => s.title).join(", ") || "(none)";
		return ok(
			{ task: input.task, candidates: [] },
			`No available MCP server named "${input.server}". Available: ${names}.`,
			`"${input.server}" not found`,
		);
	}

	private async confirmAndAdd(
		input: Input,
		item: McpRegistryItem,
		controller: McpRegistrar,
		ctx: ToolContext,
	): Promise<ToolResult<Output>> {
		// Adding a server needs a human confirm; a sub-agent can't prompt, so
		// surface the candidate instead of throwing on askUser.
		if ((ctx.agentDepth ?? 0) > 0) {
			return ok(
				{ task: input.task, candidates: [] },
				`Found the "${item.title}" MCP server, but adding it must be confirmed by the user and a sub-agent cannot prompt. Ask the main agent to run find_mcp for this task.`,
				"Confirmation needed",
			);
		}

		const envNote =
			item.requiredEnv.length > 0
				? ` Requires env vars: ${item.requiredEnv.join(", ")} (set them in your MCP config for it to connect).`
				: "";
		const answer = await ctx.askUser(
			`Add and connect the "${item.title}" MCP server?${envNote}`,
			["Add", "Cancel"],
		);
		if (answer !== "Add") {
			return ok(
				{ task: input.task, candidates: [] },
				`Skipped adding "${item.title}" (user declined). No server was added.`,
				"Add declined",
			);
		}

		let result: McpAddResult;
		try {
			result = await controller.addRegistryServer(item, ctx.signal);
		} catch (err) {
			return ok(
				{ task: input.task, candidates: [] },
				`Failed to add "${item.title}": ${errorMessage(err)}`,
				"Add failed",
			);
		}

		const tools = result.toolNames ?? [];
		const toolsLine =
			tools.length > 0
				? `New tools available: ${tools.join(", ")}.`
				: "Server added, but it exposed no tools yet (it may need authentication or env vars).";
		const warnings =
			result.warnings.length > 0
				? `\nWarnings: ${result.warnings.join("; ")}`
				: "";
		return ok(
			{
				task: input.task,
				added: item.title,
				toolNames: tools,
				candidates: [],
			},
			`Added and connected the "${item.title}" MCP server. ${toolsLine}${warnings}`,
			`Added ${item.title}`,
		);
	}
}

function listing(items: readonly McpRegistryItem[]): string {
	return items.map((s) => `- ${s.title}: ${s.description}`).join("\n");
}

/** Rank curated MCP servers by task overlap with title (weighted) and description. */
export function rankMcpServers(
	task: string,
	items: readonly McpRegistryItem[],
): Candidate[] {
	const taskTokens = tokenize(task);
	return items
		.map((item) => ({
			id: item.id,
			title: item.title,
			description: item.description,
			requiredEnv: [...item.requiredEnv],
			score: keywordScore(taskTokens, item.title, item.description),
		}))
		.sort((a, b) => b.score - a.score);
}
