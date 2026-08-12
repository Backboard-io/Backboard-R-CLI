import { describe, expect, it } from "bun:test";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { Skill } from "../src/core/skills/Skill.ts";
import type { SkillsShListItem } from "../src/core/skills/skillsSh.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import {
	FindSkillTool,
	installsValue,
	rankRemoteSkills,
	rankSkills,
	type SkillActivator,
} from "../src/tools/FindSkillTool.tsx";

function skill(
	name: string,
	description: string,
	body = `body-${name}`,
): Skill {
	return {
		name,
		description,
		body,
		dir: `/skills/${name}`,
		path: `/skills/${name}/SKILL.md`,
		source: "repo",
	};
}

function remote(id: string, slug: string, installs?: string): SkillsShListItem {
	return {
		id,
		slug,
		name: slug,
		source: id.split("/")[0] ?? "src",
		installs,
		url: `https://skills.sh/${id}`,
	};
}

class FakeSkills implements SkillActivator {
	activated: string[] = [];
	installed: string[] = [];
	constructor(
		public local: Skill[],
		public remoteList: SkillsShListItem[] = [],
	) {}
	async listLocalSkills(): Promise<Skill[]> {
		return this.local;
	}
	activateSkill(s: Skill) {
		this.activated.push(s.name);
		return { selectedName: s.name, loadedNames: [s.name] };
	}
	async listRemoteSkills(): Promise<SkillsShListItem[]> {
		return this.remoteList;
	}
	async installRemoteSkill(
		c: SkillsShListItem,
	): Promise<{ skill: Skill; downloaded: boolean }> {
		this.installed.push(c.id);
		const s = skill(c.slug, "downloaded skill", `downloaded-body-${c.slug}`);
		this.local.push(s);
		this.activated.push(s.name);
		return { skill: s, downloaded: true };
	}
}

function ctx(answer = "Download", depth = 0): ToolContext {
	return {
		sessionId: "t",
		cwd: "/tmp",
		bus: new EventBus(),
		signal: new AbortController().signal,
		askUser: async () => answer,
		agentDepth: depth,
	};
}

describe("rankSkills", () => {
	it("ranks the on-topic skill first", () => {
		const skills = [
			skill("pdf-export", "Generate a PDF from markdown"),
			skill("commit", "Write a git commit message"),
		];
		const ranked = rankSkills("write a git commit", skills);
		expect(ranked[0]?.skill.name).toBe("commit");
		expect(ranked[0]?.score ?? 0).toBeGreaterThan(0);
	});

	it("scores unrelated tasks zero", () => {
		const ranked = rankSkills("reticulate splines", [
			skill("commit", "git commit message"),
		]);
		expect(ranked[0]?.score).toBe(0);
	});
});

describe("rankRemoteSkills / installsValue", () => {
	it("breaks slug-score ties by install count", () => {
		const ranked = rankRemoteSkills("pdf", [
			remote("a/pdf", "pdf", "500"),
			remote("b/pdf", "pdf", "1.2K"),
		]);
		expect(ranked[0]?.candidate.id).toBe("b/pdf");
	});

	it("parses install counts", () => {
		expect(installsValue(remote("a/x", "x", "1.2K"))).toBe(1200);
		expect(installsValue(remote("a/x", "x", "3M"))).toBe(3_000_000);
		expect(installsValue(remote("a/x", "x"))).toBe(0);
	});

	it("tolerates lowercase suffixes and thousands separators", () => {
		expect(installsValue(remote("a/x", "x", "1.2k"))).toBe(1200);
		expect(installsValue(remote("a/x", "x", "3m"))).toBe(3_000_000);
		expect(installsValue(remote("a/x", "x", "1,200"))).toBe(1200);
	});
});

describe("FindSkillTool", () => {
	it("activates a local skill when one matches", async () => {
		const fake = new FakeSkills([
			skill("commit", "Write a git commit message"),
		]);
		const tool = new FindSkillTool(fake);
		const res = await tool.execute({ task: "write a git commit" }, ctx());
		expect(fake.activated).toEqual(["commit"]);
		expect(res.data.source).toBe("local");
		expect(res.forLLM).toContain("body-commit");
	});

	it("does not activate a weak local match below the score floor", async () => {
		const fake = new FakeSkills([
			skill("commit", "Write a git commit message"),
		]);
		const tool = new FindSkillTool(fake);
		// Only the description word "write" overlaps (score 1) — below the floor.
		const res = await tool.execute({ task: "write documentation" }, ctx());
		expect(fake.activated).toEqual([]);
		expect(res.data.activated).toBeUndefined();
	});

	it("loads a named skill directly", async () => {
		const fake = new FakeSkills([skill("commit", "x"), skill("pdf", "y")]);
		const tool = new FindSkillTool(fake);
		const res = await tool.execute({ task: "anything", skill: "pdf" }, ctx());
		expect(fake.activated).toEqual(["pdf"]);
		expect(res.data.activated).toBe("pdf");
	});

	it("downloads a remote skill after confirmation when nothing local matches", async () => {
		const fake = new FakeSkills(
			[skill("commit", "git commit message")],
			[remote("acme/pdf-tools", "pdf-tools", "2K")],
		);
		const tool = new FindSkillTool(fake);
		const res = await tool.execute(
			{ task: "convert a pdf-tools document" },
			ctx("Download"),
		);
		expect(fake.installed).toEqual(["acme/pdf-tools"]);
		expect(res.data.source).toBe("remote");
		expect(res.forLLM).toContain("Downloaded from skills.sh");
	});

	it("does not download when the user declines", async () => {
		const fake = new FakeSkills(
			[skill("commit", "git commit message")],
			[remote("acme/pdf-tools", "pdf-tools", "2K")],
		);
		const tool = new FindSkillTool(fake);
		const res = await tool.execute({ task: "pdf-tools please" }, ctx("Cancel"));
		expect(fake.installed).toEqual([]);
		expect(res.forLLM).toContain("declined");
	});

	it("never downloads from a sub-agent (cannot confirm)", async () => {
		const fake = new FakeSkills(
			[skill("commit", "git commit message")],
			[remote("acme/pdf-tools", "pdf-tools", "2K")],
		);
		const tool = new FindSkillTool(fake);
		// depth > 0 => sub-agent; even with askUser answering "Download".
		const res = await tool.execute(
			{ task: "pdf-tools please" },
			ctx("Download", 1),
		);
		expect(fake.installed).toEqual([]);
		expect(res.forLLM).toContain("sub-agent cannot prompt");
	});
});
