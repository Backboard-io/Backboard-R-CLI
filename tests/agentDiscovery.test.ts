import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCatalog } from "../src/core/agents/AgentCatalog.ts";
import type { AgentDefinition } from "../src/core/agents/AgentDefinition.ts";
import { discoverAgents } from "../src/core/agents/discovery.ts";
import { parseAgentFromMarkdown } from "../src/core/agents/parse.ts";

async function withProject(
	files: Record<string, string>,
	run: (cwd: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "cli-agents-"));
	try {
		// discoverAgents resolves the repo root via .git, so mark this dir as one.
		await mkdir(join(dir, ".git"), { recursive: true });
		const agentsDir = join(dir, ".backboard", "agents");
		await mkdir(agentsDir, { recursive: true });
		for (const [name, content] of Object.entries(files)) {
			await writeFile(join(agentsDir, name), content, "utf8");
		}
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const RESEARCHER = `---
name: researcher
description: Deep-dives one question, read-only.
tools: [read, grep, glob]
maxRounds: 30
timeoutMs: 300000
background: true
---
You are a research sub-agent. Never modify files.`;

describe("parseAgentFromMarkdown", () => {
	it("parses frontmatter and uses the body as the system prompt", () => {
		const result = parseAgentFromMarkdown(
			RESEARCHER,
			"researcher",
			"/agents/researcher.md",
			"project",
		);
		expect(result.warning).toBeUndefined();
		expect(result.agent).toMatchObject({
			name: "researcher",
			mode: "worker",
			tools: ["read", "grep", "glob"],
			maxRounds: 30,
			timeoutMs: 300_000,
			background: true,
			source: "project",
		});
		expect(result.agent?.systemPrompt).toBe(
			"You are a research sub-agent. Never modify files.",
		);
	});

	it("names the rule when a capitalized filename is rejected", () => {
		const result = parseAgentFromMarkdown(
			"---\ndescription: d\n---\nbody",
			"Researcher",
			"/agents/Researcher.md",
			"project",
		);
		expect(result.agent).toBeUndefined();
		expect(result.warning).toContain("'Researcher'");
		expect(result.warning).toContain("lowercase");
		expect(result.warning).toContain("'name:' in frontmatter");
	});

	it("lets frontmatter name rescue a capitalized filename", () => {
		const result = parseAgentFromMarkdown(
			"---\nname: researcher\ndescription: d\n---\nbody",
			"Researcher",
			"/agents/Researcher.md",
			"project",
		);
		expect(result.agent?.name).toBe("researcher");
	});

	it("falls back to the filename when name is omitted", () => {
		const result = parseAgentFromMarkdown(
			"---\ndescription: d\n---\nbody",
			"reviewer",
			"/agents/reviewer.md",
			"user",
		);
		expect(result.agent?.name).toBe("reviewer");
	});

	it("resolves provider-qualified models and treats inherit as unset", () => {
		const qualified = parseAgentFromMarkdown(
			"---\ndescription: d\nmodel: anthropic/claude-opus-5\n---\nbody",
			"a",
			"/a.md",
			"project",
		);
		expect(qualified.agent?.model).toEqual({
			provider: "anthropic",
			model: "claude-opus-5",
		});

		const inherited = parseAgentFromMarkdown(
			"---\ndescription: d\nmodel: inherit\n---\nbody",
			"a",
			"/a.md",
			"project",
		);
		expect(inherited.agent?.model).toBeUndefined();
	});

	it.each([
		["/", "model: /"],
		["missing model", "model: anthropic/"],
		["missing provider", "model: /claude-opus-5"],
		["whitespace parts", 'model: " / "'],
	])("rejects a malformed model reference (%s)", (_label, line) => {
		const result = parseAgentFromMarkdown(
			`---\ndescription: d\n${line}\n---\nbody`,
			"a",
			"/a.md",
			"project",
		);
		expect(result.agent).toBeUndefined();
		expect(result.warning).toContain("invalid model");
	});

	it.each([
		["number", "model: 123"],
		["null", "model: null"],
		["empty string", 'model: ""'],
		["mapping", "model:\n  provider: anthropic"],
		["sequence", "model: [anthropic/claude-opus-5]"],
	])("rejects an explicit non-string model value (%s)", (_label, line) => {
		const result = parseAgentFromMarkdown(
			`---\ndescription: d\n${line}\n---\nbody`,
			"a",
			"/a.md",
			"project",
		);
		expect(result.agent).toBeUndefined();
		expect(result.warning).toContain("invalid model");
	});

	it("trims whitespace around qualified model parts", () => {
		const result = parseAgentFromMarkdown(
			'---\ndescription: d\nmodel: " anthropic / claude-opus-5 "\n---\nbody',
			"a",
			"/a.md",
			"project",
		);
		expect(result.agent?.model).toEqual({
			provider: "anthropic",
			model: "claude-opus-5",
		});
	});

	it.each([
		["missing frontmatter", "no frontmatter here", "missing YAML frontmatter"],
		["missing description", "---\nname: a\n---\nbody", "missing description"],
		["empty body", "---\ndescription: d\n---\n", "missing system prompt body"],
		["bad mode", "---\ndescription: d\nmode: swarm\n---\nbody", "mode must be"],
		[
			"bad name",
			"---\nname: Bad Name\ndescription: d\n---\nbody",
			"use lowercase letters, digits, and hyphens only",
		],
		[
			"bad tools",
			"---\ndescription: d\ntools: read\n---\nbody",
			"tools must be a list",
		],
		[
			"bad maxRounds",
			"---\ndescription: d\nmaxRounds: 0\n---\nbody",
			"maxRounds must be a positive integer",
		],
	])("rejects %s", (_label, content, expected) => {
		const result = parseAgentFromMarkdown(content, "a", "/a.md", "project");
		expect(result.agent).toBeUndefined();
		expect(result.warning).toContain(expected);
	});
});

describe("AgentCatalog", () => {
	const agent = (name: string, description: string): AgentDefinition => ({
		name,
		description,
		mode: "worker",
		systemPrompt: "p",
		source: "project",
	});

	it("keeps the first definition for a repeated name", () => {
		const catalog = new AgentCatalog([
			agent("dup", "project wins"),
			agent("dup", "user loses"),
			agent("other", "kept"),
		]);
		expect(catalog.get("dup")?.description).toBe("project wins");
		expect(catalog.names).toEqual(["dup", "other"]);
	});

	it("keeps lookups, names, and the prompt catalog consistent", () => {
		const catalog = new AgentCatalog([
			agent("dup", "first"),
			agent("dup", "second"),
		]);
		expect(catalog.agents).toHaveLength(1);
		expect(catalog.promptCatalog).toBe("- `dup`: first");
		expect(catalog.names.map((n) => catalog.get(n)?.description)).toEqual([
			"first",
		]);
	});
});

describe("discoverAgents", () => {
	it("always exposes the built-in worker and rlm agents", async () => {
		const catalog = await discoverAgents({
			cwd: process.cwd(),
			includeProjectAgents: false,
			includeUserAgents: false,
		});
		expect(catalog.names).toEqual(["worker", "rlm"]);
		expect(catalog.get("worker")?.mode).toBe("worker");
		expect(catalog.get("rlm")?.mode).toBe("rlm");
	});

	it("loads project agents ahead of built-ins and skips invalid files", async () => {
		await withProject(
			{ "researcher.md": RESEARCHER, "broken.md": "not an agent" },
			async (cwd) => {
				const catalog = await discoverAgents({
					cwd,
					includeUserAgents: false,
				});
				expect(catalog.names).toEqual(["researcher", "worker", "rlm"]);
				expect(catalog.get("researcher")?.source).toBe("project");
				expect(catalog.warnings.join("\n")).toContain("broken.md");
			},
		);
	});

	it("lets a project agent shadow a built-in of the same name", async () => {
		await withProject(
			{ "worker.md": "---\ndescription: custom\n---\nCustom worker prompt." },
			async (cwd) => {
				const catalog = await discoverAgents({
					cwd,
					includeUserAgents: false,
				});
				expect(catalog.names).toEqual(["worker", "rlm"]);
				expect(catalog.get("worker")?.systemPrompt).toBe(
					"Custom worker prompt.",
				);
				expect(catalog.get("worker")?.source).toBe("project");
			},
		);
	});

	it("renders a prompt catalog listing every agent", async () => {
		await withProject({ "researcher.md": RESEARCHER }, async (cwd) => {
			const catalog = await discoverAgents({ cwd, includeUserAgents: false });
			expect(catalog.promptCatalog).toContain(
				"- `researcher`: Deep-dives one question, read-only.",
			);
			expect(catalog.promptCatalog).toContain("- `worker`:");
		});
	});
});
