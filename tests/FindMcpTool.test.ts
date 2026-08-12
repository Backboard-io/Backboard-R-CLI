import { describe, expect, it } from "bun:test";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type {
	McpAddResult,
	McpRegistryItem,
	McpServerRuntimeStatus,
} from "../src/core/mcp/index.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import {
	FindMcpTool,
	type McpRegistrar,
	rankMcpServers,
} from "../src/tools/FindMcpTool.tsx";

function server(
	id: string,
	title: string,
	description: string,
	opts: { requiredEnv?: string[]; disabledReason?: string } = {},
): McpRegistryItem {
	return {
		id,
		title,
		category: "Development & Testing",
		description,
		detail: "",
		requiredEnv: opts.requiredEnv ?? [],
		...(opts.disabledReason ? { disabledReason: opts.disabledReason } : {}),
	};
}

class FakeMcp implements McpRegistrar {
	added: string[] = [];
	constructor(
		public servers: McpRegistryItem[],
		public active: string[] = [],
	) {}
	listServerStatuses(): McpServerRuntimeStatus[] {
		return this.active.map(
			(name) => ({ name }) as unknown as McpServerRuntimeStatus,
		);
	}
	async listRegistryServers(): Promise<McpRegistryItem[]> {
		return this.servers;
	}
	async addRegistryServer(item: McpRegistryItem): Promise<McpAddResult> {
		this.added.push(item.id);
		return {
			name: item.id,
			title: item.title,
			requiredEnv: [...item.requiredEnv],
			toolNames: [`${item.id}__query`],
			warnings: [],
		};
	}
}

function ctx(answer = "Add", depth = 0): ToolContext {
	return {
		sessionId: "t",
		cwd: "/tmp",
		bus: new EventBus(),
		signal: new AbortController().signal,
		askUser: async () => answer,
		agentDepth: depth,
	};
}

describe("rankMcpServers", () => {
	it("ranks by title/description overlap", () => {
		const ranked = rankMcpServers("query a postgres database", [
			server("linear", "Linear", "Track issues and projects"),
			server("postgres", "Postgres", "Query a Postgres database"),
		]);
		expect(ranked[0]?.id).toBe("postgres");
	});
});

describe("FindMcpTool", () => {
	it("adds the best server after confirmation", async () => {
		const fake = new FakeMcp([
			server("linear", "Linear", "Track issues and projects"),
			server("postgres", "Postgres", "Query a Postgres database"),
		]);
		const tool = new FindMcpTool(() => fake);
		const res = await tool.execute(
			{ task: "query a postgres database" },
			ctx("Add"),
		);
		expect(fake.added).toEqual(["postgres"]);
		expect(res.data.added).toBe("Postgres");
		expect(res.forLLM).toContain("postgres__query");
	});

	it("does not add when declined", async () => {
		const fake = new FakeMcp([
			server("postgres", "Postgres", "Query a Postgres database"),
		]);
		const tool = new FindMcpTool(() => fake);
		const res = await tool.execute(
			{ task: "postgres database" },
			ctx("Cancel"),
		);
		expect(fake.added).toEqual([]);
		expect(res.forLLM).toContain("declined");
	});

	it("skips already-connected servers", async () => {
		const fake = new FakeMcp(
			[server("postgres", "Postgres", "Query a Postgres database")],
			["postgres"],
		);
		const tool = new FindMcpTool(() => fake);
		const res = await tool.execute({ task: "postgres database" }, ctx("Add"));
		expect(fake.added).toEqual([]);
		expect(res.forLLM).toContain("No MCP servers are available");
	});

	it("reports a named server that is already connected", async () => {
		const fake = new FakeMcp(
			[
				server("postgres", "Postgres", "Query a Postgres database"),
				server("linear", "Linear", "Track issues and projects"),
			],
			["postgres"],
		);
		const tool = new FindMcpTool(() => fake);
		const res = await tool.execute(
			{ task: "postgres", server: "Postgres" },
			ctx("Add"),
		);
		expect(fake.added).toEqual([]);
		expect(res.forLLM).toContain("already connected");
	});

	it("surfaces the disabled reason for a named disabled server", async () => {
		const fake = new FakeMcp([
			server("postgres", "Postgres", "Query a Postgres database", {
				disabledReason: "requires PG_URL",
			}),
		]);
		const tool = new FindMcpTool(() => fake);
		const res = await tool.execute(
			{ task: "postgres", server: "Postgres" },
			ctx("Add"),
		);
		expect(fake.added).toEqual([]);
		expect(res.forLLM).toContain("requires PG_URL");
	});

	it("reports unavailable when no controller is present", async () => {
		const tool = new FindMcpTool(() => undefined);
		const res = await tool.execute({ task: "anything" }, ctx());
		expect(res.forLLM).toContain("MCP is not available");
	});

	it("never adds from a sub-agent (cannot confirm)", async () => {
		const fake = new FakeMcp([
			server("postgres", "Postgres", "Query a Postgres database"),
		]);
		const tool = new FindMcpTool(() => fake);
		const res = await tool.execute(
			{ task: "query a postgres database" },
			ctx("Add", 1),
		);
		expect(fake.added).toEqual([]);
		expect(res.forLLM).toContain("sub-agent cannot prompt");
	});
});
