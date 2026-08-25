import { z } from "zod";
import type { Skill } from "../core/skills/Skill.ts";
import type { SkillsShListItem } from "../core/skills/skillsSh.ts";
import { Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import { errorMessage } from "../utils/errors.ts";
import { keywordScore, tokenize } from "./discoveryMatch.ts";

/** Narrow view of SkillController this tool needs. */
export interface SkillActivator {
	listLocalSkills(): Promise<Skill[]>;
	activateSkill(skill: Skill): { selectedName: string; loadedNames: string[] };
	listRemoteSkills(signal?: AbortSignal): Promise<SkillsShListItem[]>;
	installRemoteSkill(
		candidate: SkillsShListItem,
		signal?: AbortSignal,
	): Promise<{ skill: Skill; downloaded: boolean }>;
}

const schema = z.object({
	task: z
		.string()
		.min(1)
		.describe("A short description of what you're about to do"),
	skill: z
		.string()
		.optional()
		.describe("Load this specific installed skill by name instead of ranking"),
});

type Input = z.infer<typeof schema>;

interface Candidate {
	name: string;
	description: string;
	score: number;
}

interface ScoredSkill {
	skill: Skill;
	score: number;
}

interface Output {
	task: string;
	activated?: string;
	downloaded?: string;
	source?: "local" | "remote";
	candidates: Candidate[];
}

const MAX_CANDIDATES = 5;
const ALTERNATE_LIMIT = 4;
const REMOTE_SUGGESTION_LIMIT = 6;
const MAX_SKILL_BODY_CHARS = 16_000;
// Require a real signal (one name hit, or several description hits) before
// silently activating a local skill and injecting its body into context.
const MIN_LOCAL_ACTIVATION_SCORE = 3;

interface ScoredRemote {
	candidate: SkillsShListItem;
	score: number;
}

/** Local-first skill acquisition; falls back to skills.sh behind a confirm gate. */
export class FindSkillTool extends Tool<Input, Output> {
	readonly name = "FindSkill";
	readonly inputSchema = schema;

	constructor(private readonly controller: SkillActivator) {
		super();
	}

	override prompt(): string {
		return [
			"Find and load a project skill that fits the current task.",
			"First searches skills installed in this repo and your personal library",
			"(matched by description) and activates the best fit, returning its",
			"instructions inline. If nothing local matches, it searches the skills.sh",
			"directory and, after asking the user for confirmation, downloads and",
			"activates the best remote match.",
			"Pass `task` describing what you're about to do; optionally pass `skill`",
			"to load a specific installed skill by name. Reach for this when starting",
			"a workflow a specialized skill likely covers and none is already loaded.",
		].join(" ");
	}

	override isReadOnly(): boolean {
		return false;
	}

	override isConcurrencySafe(): boolean {
		return false;
	}

	override summarizeInput(input: Input): string | undefined {
		return input.skill ? `load ${input.skill}` : input.task;
	}

	override async execute(
		input: Input,
		ctx: ToolContext,
	): Promise<ToolResult<Output>> {
		const skills = await this.controller.listLocalSkills();

		if (input.skill) {
			return this.activateNamed(input, skills);
		}

		const localHit = this.tryLocal(input, skills);
		if (localHit) return localHit;

		return this.tryRemote(input, ctx, skills);
	}

	private activateNamed(input: Input, skills: Skill[]): ToolResult<Output> {
		const target = input.skill?.trim().toLowerCase();
		const match = skills.find((s) => s.name.toLowerCase() === target);
		if (!match) {
			const names = skills.map((s) => s.name).join(", ") || "(none)";
			return ok(
				{ task: input.task, candidates: [] },
				`No installed skill named "${input.skill}". Installed skills: ${names}.`,
				`Skill "${input.skill}" not found`,
			);
		}
		this.controller.activateSkill(match);
		return ok(
			{
				task: input.task,
				activated: match.name,
				source: "local",
				candidates: [],
			},
			renderActivated(match, []),
			`Activated ${match.name}`,
		);
	}

	private tryLocal(input: Input, skills: Skill[]): ToolResult<Output> | null {
		if (skills.length === 0) return null;
		const ranked = rankSkills(input.task, skills);
		const best = ranked[0];
		if (!best || best.score < MIN_LOCAL_ACTIVATION_SCORE) return null;

		const chosen = best.skill;
		this.controller.activateSkill(chosen);
		const positives = ranked.filter((r) => r.score > 0);
		const alternates = positives
			.slice(1)
			.slice(0, ALTERNATE_LIMIT)
			.map((r) => r.skill.name);

		return ok(
			{
				task: input.task,
				activated: chosen.name,
				source: "local",
				candidates: positives
					.slice(0, MAX_CANDIDATES)
					.map(scoredSkillCandidate),
			},
			renderActivated(chosen, alternates),
			`Activated ${chosen.name}`,
		);
	}

	private async tryRemote(
		input: Input,
		ctx: ToolContext,
		localSkills: Skill[],
	): Promise<ToolResult<Output>> {
		let candidates: SkillsShListItem[];
		try {
			candidates = await this.controller.listRemoteSkills(ctx.signal);
		} catch (err) {
			return ok(
				{ task: input.task, candidates: [] },
				`No installed skill matched "${input.task}", and skills.sh could not be reached: ${errorMessage(err)}\n\n${installedListing(localSkills)}`,
				"skills.sh unavailable",
			);
		}

		if (candidates.length === 0) {
			return ok(
				{ task: input.task, candidates: [] },
				`No installed skill matched "${input.task}", and skills.sh returned no skills.\n\n${installedListing(localSkills)}`,
				"No match",
			);
		}

		const ranked = rankRemoteSkills(input.task, candidates);
		const best = ranked[0];
		if (!best || best.score <= 0) {
			return ok(
				{ task: input.task, candidates: [] },
				`No installed or skills.sh skill clearly matched "${input.task}".\n\n${installedListing(localSkills)}\n\nClosest skills.sh entries — re-run find_skill with a more specific task to download one:\n${remoteListing(ranked)}`,
				"No clear match",
			);
		}

		const c = best.candidate;

		// A download runs third-party code and needs a human confirm; a sub-agent
		// can't prompt, so surface the candidate instead of throwing on askUser.
		if ((ctx.agentDepth ?? 0) > 0 || ctx.permissions?.interactive === false) {
			const reason =
				(ctx.agentDepth ?? 0) > 0
					? "a sub-agent cannot prompt"
					: "this run is non-interactive";
			return ok(
				{ task: input.task, candidates: remoteCandidates(ranked) },
				`Found "${c.slug}" on skills.sh, but downloading a third-party skill must be confirmed by the user and ${reason}. Run find_skill in an interactive main-agent session for this task.`,
				"Confirmation needed",
			);
		}

		const answer = await ctx.askUser(
			`Download and use "${c.slug}" from skills.sh?` +
				` Source: ${c.source}${c.installs ? `, ${c.installs} installs` : ""}.` +
				` This runs "npx skills add" to install third-party code into this repo.`,
			["Download", "Cancel"],
		);
		if (answer !== "Download") {
			return ok(
				{ task: input.task, candidates: remoteCandidates(ranked) },
				`Skipped downloading "${c.slug}" (user declined). No skill was installed.`,
				"Download declined",
			);
		}

		let skill: Skill;
		let downloaded: boolean;
		try {
			({ skill, downloaded } = await this.controller.installRemoteSkill(
				c,
				ctx.signal,
			));
		} catch (err) {
			return ok(
				{ task: input.task, candidates: remoteCandidates(ranked) },
				`Failed to download "${c.slug}" from skills.sh: ${errorMessage(err)}`,
				"Download failed",
			);
		}

		return ok(
			{
				task: input.task,
				activated: skill.name,
				downloaded: downloaded ? c.id : undefined,
				source: downloaded ? "remote" : "local",
				candidates: [],
			},
			downloaded
				? `${renderActivated(skill, [])}\n\n(Downloaded from skills.sh: ${c.url})`
				: `${renderActivated(skill, [])}\n\n(A skill named "${skill.name}" was already loaded; nothing was downloaded.)`,
			downloaded ? `Downloaded ${skill.name}` : `Activated ${skill.name}`,
		);
	}
}

function renderActivated(skill: Skill, alternates: string[]): string {
	const body = skill.body.trim();
	const clipped =
		body.length > MAX_SKILL_BODY_CHARS
			? `${body.slice(0, MAX_SKILL_BODY_CHARS)}\n\n[…truncated; read ${skill.path} for the full skill]`
			: body;
	const parts = [
		`Activated skill "${skill.name}". Follow these instructions:`,
		"",
		clipped,
	];
	if (alternates.length > 0) {
		parts.push(
			"",
			`Other local skills that may also fit: ${alternates.join(", ")}. ` +
				'Load one with find_skill({ skill: "<name>" }) if this one is wrong.',
		);
	}
	return parts.join("\n");
}

function installedListing(skills: readonly Skill[]): string {
	if (skills.length === 0) return "No skills are installed locally.";
	const lines = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
	return `Installed skills:\n${lines}`;
}

/** Ranked skills.sh entries as structured candidates (positive scores only). */
function remoteCandidates(ranked: readonly ScoredRemote[]): Candidate[] {
	return ranked
		.filter((r) => r.score > 0)
		.slice(0, MAX_CANDIDATES)
		.map((r) => ({
			name: r.candidate.slug,
			description: r.candidate.source,
			score: r.score,
		}));
}

function remoteListing(ranked: readonly ScoredRemote[]): string {
	return (
		ranked
			.slice(0, REMOTE_SUGGESTION_LIMIT)
			.map((r) => {
				const installs = r.candidate.installs
					? ` (${r.candidate.installs} installs)`
					: "";
				return `- ${r.candidate.slug} [${r.candidate.source}]${installs}`;
			})
			.join("\n") || "(none)"
	);
}

/** Lexical ranker: overlap of task keywords with skill name (weighted) and description. */
export function rankSkills(
	task: string,
	skills: readonly Skill[],
): ScoredSkill[] {
	const taskTokens = tokenize(task);
	return skills
		.map((skill) => ({
			skill,
			score: keywordScore(taskTokens, skill.name, skill.description),
		}))
		.sort((a, b) => b.score - a.score);
}

function scoredSkillCandidate(r: ScoredSkill): Candidate {
	return {
		name: r.skill.name,
		description: r.skill.description,
		score: r.score,
	};
}

/** Rank skills.sh candidates by slug token overlap; break ties by install count. */
export function rankRemoteSkills(
	task: string,
	candidates: readonly SkillsShListItem[],
): ScoredRemote[] {
	const taskTokens = tokenize(task);
	return candidates
		.map((candidate) => ({
			candidate,
			score: keywordScore(taskTokens, candidate.slug),
		}))
		.sort(
			(a, b) =>
				b.score - a.score ||
				installsValue(b.candidate) - installsValue(a.candidate),
		);
}

/** Parse a skills.sh install count like "1.2K" / "3M" / "500" into a number. */
export function installsValue(candidate: SkillsShListItem): number {
	// Drop thousands separators ("1,200") before matching; tolerate lowercase suffixes.
	const raw = candidate.installs?.trim().replace(/,(?=\d{3}\b)/g, "");
	if (!raw) return 0;
	const match = /^(\d+(?:\.\d+)?)([KMB]?)$/i.exec(raw);
	if (!match?.[1]) return 0;
	const base = Number(match[1]);
	const suffix = match[2]?.toUpperCase();
	const mult =
		suffix === "K" ? 1e3 : suffix === "M" ? 1e6 : suffix === "B" ? 1e9 : 1;
	return base * mult;
}
