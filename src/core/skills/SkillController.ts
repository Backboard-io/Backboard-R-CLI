import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { APP_DISPLAY_NAME } from "../../config/branding.ts";
import { buildActivatedSkillsPrompt } from "../../prompts/system/skills.tsx";
import { errorMessage } from "../../utils/errors.ts";
import type { EventBus } from "../bus/EventBus.ts";
import { extractSkillInvocations } from "./activation.ts";
import { discoverSkills } from "./discovery.ts";
import type { Skill } from "./Skill.ts";
import { buildSkillCatalog, type SkillCatalog } from "./SkillCatalog.ts";
import {
	cloneSkillPickerTabs,
	SKILL_PICKER_CACHE_TTL_MS,
	SkillPickerCache,
	type SkillPickerState,
} from "./SkillPickerCache.ts";
import type {
	SkillInstallTarget,
	SkillPickerItem,
	SkillPickerSource,
	SkillPickerTab,
} from "./SkillPickerTypes.ts";
import {
	SkillsShClient,
	type SkillsShListItem,
	splitSkillsShId,
} from "./skillsSh.ts";

export interface SkillControllerDeps {
	cwd: string;
	bus: EventBus;
	skillsSh?: SkillsShClient;
	homeDir?: string;
}

export interface SkillLoadResult {
	selectedName: string;
	loadedNames: string[];
	action: "activated" | "deactivated";
}

export interface SkillPromptContext {
	skillCatalog?: SkillCatalog;
	activatedSkillsPrompt?: string;
}

export interface RemoteSkillInstall {
	skill: Skill;
	downloaded: boolean;
}

export type {
	SkillInstallTarget,
	SkillPickerItem,
	SkillPickerSource,
	SkillPickerTab,
} from "./SkillPickerTypes.ts";

/**
 * Owns skill discovery, picker state, remote import, selected-skill catalogs,
 * and per-turn activation prompt expansion.
 */
export class SkillController {
	private skillCatalog: SkillCatalog | undefined;
	private readonly selectedSkills = new Map<string, Skill>();
	private readonly pickerSkills = new Map<string, Skill>();
	private readonly skillsSh: SkillsShClient;
	private readonly pickerCache = new SkillPickerCache();

	constructor(private readonly deps: SkillControllerDeps) {
		this.skillsSh = deps.skillsSh ?? new SkillsShClient();
	}

	async buildPromptContext(text: string): Promise<SkillPromptContext> {
		return {
			skillCatalog: this.skillCatalog,
			activatedSkillsPrompt: await this.buildActivatedPrompt(text),
		};
	}

	/** Locally-installed skills (repo + personal) for ranking. */
	async listLocalSkills(): Promise<Skill[]> {
		const catalog = await discoverSkills({
			cwd: this.deps.cwd,
			homeDir: this.deps.homeDir,
		});
		for (const warning of catalog.warnings) {
			this.deps.bus.emit({ type: "system:warning", message: warning });
		}
		return [...catalog.skills];
	}

	/** Add a local skill to the selected set and rebuild the catalog. */
	activateSkill(skill: Skill): SkillLoadResult {
		this.selectedSkills.set(skill.name, skill);
		return {
			selectedName: skill.name,
			loadedNames: this.rebuildCatalog(),
			action: "activated",
		};
	}

	/** Whether a skill with this name is loaded into the session. */
	isSkillLoaded(name: string): boolean {
		return this.selectedSkills.has(name);
	}

	/** Drop a skill from the selected set and rebuild the catalog. */
	deactivateSkill(name: string): SkillLoadResult {
		this.selectedSkills.delete(name);
		return {
			selectedName: name,
			loadedNames: this.rebuildCatalog(),
			action: "deactivated",
		};
	}

	private rebuildCatalog(): string[] {
		if (this.selectedSkills.size === 0) {
			this.skillCatalog = undefined;
			return [];
		}
		const catalog = buildSkillCatalog([...this.selectedSkills.values()]);
		this.skillCatalog = catalog;
		for (const warning of catalog.warnings) {
			this.deps.bus.emit({ type: "system:warning", message: warning });
		}
		return catalog.skillNames;
	}

	/** Public skills.sh directory listing (trending/hot/official), used for ranking. */
	async listRemoteSkills(signal?: AbortSignal): Promise<SkillsShListItem[]> {
		return this.skillsSh.listDirectory(signal);
	}

	/** Download a skills.sh skill and activate it (same path as the picker). */
	async installRemoteSkill(
		candidate: SkillsShListItem,
		signal?: AbortSignal,
	): Promise<RemoteSkillInstall> {
		const active = this.selectedSkills.get(candidate.slug);
		if (active) return { skill: active, downloaded: false };
		const result = await this.selectSkill(
			skillsShPickerItem(candidate),
			signal,
		);
		const skill = this.selectedSkills.get(result.selectedName);
		if (!skill) {
			throw new Error(
				`Installed ${candidate.slug} but could not load it into the session.`,
			);
		}
		return { skill, downloaded: true };
	}

	async listSkillTabs(): Promise<SkillPickerTab[]> {
		const cached = this.pickerCache.get();
		if (cached) {
			this.restorePickerState(cached);
			this.emitPickerWarnings(cached);
			if (this.pickerCache.isStale(cached)) {
				void this.refreshPickerState(true).catch(() => undefined);
			}
			return this.markActiveSkills(cloneSkillPickerTabs(cached.tabs));
		}

		const state = await this.refreshPickerState();
		this.restorePickerState(state);
		this.emitPickerWarnings(state);
		return this.markActiveSkills(cloneSkillPickerTabs(state.tabs));
	}

	private markActiveSkills(tabs: SkillPickerTab[]): SkillPickerTab[] {
		for (const tab of tabs) {
			for (const item of tab.items) {
				item.active = this.isItemActive(item);
			}
		}
		return tabs;
	}

	private isItemActive(item: SkillPickerItem): boolean {
		const selected = this.selectedSkills.get(item.name);
		if (!selected) return false;
		if (item.source === "skills-sh") return true;
		return this.pickerSkills.get(keyForItem(item))?.path === selected.path;
	}

	async preloadSkillTabs(): Promise<void> {
		try {
			await this.refreshPickerState();
		} catch {
			// User-triggered /skills will surface loading errors when needed.
		}
	}

	async selectSkill(
		item: SkillPickerItem,
		signal?: AbortSignal,
		target: SkillInstallTarget = "repo",
	): Promise<SkillLoadResult> {
		if (item.source === "skills-sh") {
			if (this.selectedSkills.has(item.name)) {
				return this.deactivateSkill(item.name);
			}
			return this.activateSkill(
				await this.importSkillsShSkill(item, signal, target),
			);
		}
		const skill = this.pickerSkills.get(keyForItem(item));
		if (!skill) throw new Error(`Unknown skill: ${item.name}`);
		if (this.selectedSkills.get(skill.name)?.path === skill.path) {
			return this.deactivateSkill(skill.name);
		}
		return this.activateSkill(skill);
	}

	/** Delete an installed skill from disk and drop it from the session. */
	async removeSkill(item: SkillPickerItem): Promise<void> {
		if (item.source === "skills-sh") {
			throw new Error(`Skill ${item.name} is not installed locally.`);
		}
		const skill = this.pickerSkills.get(keyForItem(item));
		if (!skill) throw new Error(`Unknown skill: ${item.name}`);
		const dir = path.dirname(skill.path);
		const segments = dir.split(path.sep);
		const agentsIndex = segments.lastIndexOf(".agents");
		if (
			path.basename(dir) !== skill.name ||
			agentsIndex < 0 ||
			segments[agentsIndex + 1] !== "skills"
		) {
			throw new Error(
				`Refusing to remove unexpected skill path: ${skill.path}`,
			);
		}
		await rm(dir, { recursive: true, force: true });
		await removeEmptyDirectory(path.dirname(dir));
		await removeEmptyDirectory(path.dirname(path.dirname(dir)));
		this.pickerSkills.delete(keyForItem(item));
		this.pickerCache.invalidate();
		if (this.selectedSkills.get(skill.name)?.path === skill.path) {
			this.deactivateSkill(skill.name);
		}
	}

	private itemsForSkills(
		source: Exclude<SkillPickerSource, "skills-sh">,
		skills: readonly Skill[],
		pickerSkills = this.pickerSkills,
	): SkillPickerItem[] {
		return skills.map((skill) => {
			const item: SkillPickerItem = {
				id: skill.name,
				name: skill.name,
				description: skill.description,
				source,
				detail: skill.path,
			};
			pickerSkills.set(keyForItem(item), skill);
			return item;
		});
	}

	private async refreshPickerState(
		refreshRemote = false,
	): Promise<SkillPickerState> {
		return this.pickerCache.refresh(() => this.loadPickerState(refreshRemote));
	}

	private async loadPickerState(
		refreshRemote: boolean,
	): Promise<SkillPickerState> {
		const pickerSkills = new Map<string, Skill>();
		const [repo, personal] = await Promise.all([
			discoverSkills({
				cwd: this.deps.cwd,
				includeUserSkills: false,
			}),
			discoverSkills({
				cwd: this.deps.cwd,
				includeRepoSkills: false,
				homeDir: this.deps.homeDir,
			}),
		]);

		const remote = await this.listSkillsShTab(refreshRemote);
		const state: SkillPickerState = {
			expiresAt: Date.now() + SKILL_PICKER_CACHE_TTL_MS,
			pickerSkills,
			warnings: [...repo.warnings, ...personal.warnings],
			tabs: [
				{
					id: "repo",
					label: "Repo",
					items: this.itemsForSkills("repo", repo.skills, pickerSkills),
				},
				{
					id: "personal",
					label: "Personal",
					items: this.itemsForSkills("personal", personal.skills, pickerSkills),
				},
				remote,
			],
		};
		return state;
	}

	private restorePickerState(state: SkillPickerState): void {
		this.pickerSkills.clear();
		for (const [key, skill] of state.pickerSkills) {
			this.pickerSkills.set(key, skill);
		}
	}

	private emitPickerWarnings(state: SkillPickerState): void {
		for (const warning of state.warnings) {
			this.deps.bus.emit({ type: "system:warning", message: warning });
		}
	}

	private async listSkillsShTab(refresh: boolean): Promise<SkillPickerTab> {
		try {
			const skills = refresh
				? await this.skillsSh.refreshDirectory()
				: await this.skillsSh.listDirectory();
			return {
				id: "skills-sh",
				label: "skills.sh",
				items: skills.map(skillsShPickerItem),
			};
		} catch (err) {
			return {
				id: "skills-sh",
				label: "skills.sh",
				items: [],
				error: errorMessage(err),
			};
		}
	}

	private async buildActivatedPrompt(text: string): Promise<string> {
		if (!this.skillCatalog) return "";
		const names = extractSkillInvocations(text, this.skillCatalog);
		return buildActivatedSkillsPrompt(this.skillCatalog, names);
	}

	private skillRootFor(target: SkillInstallTarget): string {
		const base =
			target === "personal"
				? (this.deps.homeDir ?? os.homedir())
				: this.deps.cwd;
		return path.join(base, ".agents", "skills");
	}

	private async importSkillsShSkill(
		item: SkillPickerItem,
		signal?: AbortSignal,
		target: SkillInstallTarget = "repo",
	): Promise<Skill> {
		const lockPath = path.join(this.deps.cwd, "skills-lock.json");
		const hadLockfile = existsSync(lockPath);
		const hadProjectCopy = existsSync(
			path.join(this.skillRootFor("repo"), item.name),
		);
		await this.skillsSh.importSkill(item.id, this.deps.cwd, signal);
		await this.normalizeSkillsCliImport(item, target, hadProjectCopy);
		if (!hadLockfile) await rm(lockPath, { force: true });

		const catalog =
			target === "personal"
				? await discoverSkills({
						cwd: this.deps.cwd,
						includeRepoSkills: false,
						homeDir: this.deps.homeDir,
					})
				: await discoverSkills({
						cwd: this.deps.cwd,
						includeUserSkills: false,
					});
		for (const warning of catalog.warnings) {
			this.deps.bus.emit({ type: "system:warning", message: warning });
		}

		const imported = catalog.get(item.name);
		if (!imported) {
			throw new Error(
				`Imported ${item.name}, but ${APP_DISPLAY_NAME} could not find it in ${this.skillRootFor(target)}.`,
			);
		}
		const pickerItem: SkillPickerItem = {
			id: imported.name,
			name: imported.name,
			description: imported.description,
			source: target,
			detail: imported.path,
		};
		this.pickerSkills.set(keyForItem(pickerItem), imported);
		this.pickerCache.invalidate();
		return imported;
	}

	private async normalizeSkillsCliImport(
		item: SkillPickerItem,
		target: SkillInstallTarget,
		hadProjectCopy: boolean,
	): Promise<void> {
		const sourcePath = await skillsCliSkillPath(this.deps.cwd, item);
		if (!sourcePath) return;

		const sourceDir = path.dirname(sourcePath);
		const targetDir = path.join(this.skillRootFor(target), item.name);
		if (path.resolve(sourceDir) === path.resolve(targetDir)) return;
		if (!existsSync(targetDir)) {
			await mkdir(path.dirname(targetDir), { recursive: true });
			await cp(sourceDir, targetDir, {
				recursive: true,
				errorOnExist: true,
				force: false,
			});
		}
		const keepSource =
			hadProjectCopy &&
			path.resolve(sourceDir) ===
				path.resolve(path.join(this.skillRootFor("repo"), item.name));
		if (keepSource) return;
		await rm(sourceDir, { recursive: true, force: true });
		await removeEmptyDirectory(path.join(this.deps.cwd, "skills"));
		await removeEmptyDirectory(path.join(this.deps.cwd, ".agents", "skills"));
		await removeEmptyDirectory(path.join(this.deps.cwd, ".agents"));
	}
}

function keyForItem(item: SkillPickerItem): string {
	return `${item.source}:${item.id}`;
}

/**
 * Map a skills.sh listing to a picker item. `source` fills `description` — the
 * skills.sh tab renders it as the subtitle; the programmatic import path in
 * `installRemoteSkill` never reads it.
 */
function skillsShPickerItem(item: SkillsShListItem): SkillPickerItem {
	return {
		id: item.id,
		name: item.slug,
		description: item.source,
		source: "skills-sh",
		detail: item.url,
		installs: item.installs,
	};
}

async function skillsCliSkillPath(
	cwd: string,
	item: SkillPickerItem,
): Promise<string | undefined> {
	const candidates = [
		await lockfileSkillPath(cwd, item),
		insideCwd(cwd, path.join("skills", item.name, "SKILL.md")),
		insideCwd(cwd, path.join(".agents", "skills", item.name, "SKILL.md")),
	];
	return candidates.find(
		(candidate) => candidate !== undefined && existsSync(candidate),
	);
}

async function lockfileSkillPath(
	cwd: string,
	item: SkillPickerItem,
): Promise<string | undefined> {
	const lockPath = path.join(cwd, "skills-lock.json");
	if (!existsSync(lockPath)) return undefined;

	try {
		const raw = await readFile(lockPath, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed) || !isRecord(parsed.skills)) return undefined;

		const { source, slug } = splitSkillsShId(item.id);
		const entry = matchingLockEntry(parsed.skills, source, slug, item.name);
		const skillPath = isRecord(entry)
			? stringValue(entry.skillPath)
			: undefined;
		return skillPath ? insideCwd(cwd, skillPath) : undefined;
	} catch {
		return undefined;
	}
}

function matchingLockEntry(
	skills: Record<string, unknown>,
	source: string,
	slug: string,
	name: string,
): unknown {
	const direct = skills[name] ?? skills[slug];
	if (isRecord(direct) && stringValue(direct.source) === source) {
		return direct;
	}

	for (const [key, entry] of Object.entries(skills)) {
		if (!isRecord(entry)) continue;
		if (stringValue(entry.source) !== source) continue;
		const skillPath = stringValue(entry.skillPath);
		if (
			key === name ||
			key === slug ||
			pathSegments(skillPath).includes(name) ||
			pathSegments(skillPath).includes(slug)
		) {
			return entry;
		}
	}
	return undefined;
}

function insideCwd(cwd: string, relativePath: string): string | undefined {
	const root = path.resolve(cwd);
	const resolved = path.resolve(root, relativePath);
	return resolved.startsWith(`${root}${path.sep}`) ? resolved : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pathSegments(value: string | undefined): string[] {
	return value ? value.split(/[\\/]/).filter(Boolean) : [];
}

async function removeEmptyDirectory(dir: string): Promise<void> {
	try {
		await rmdir(dir);
	} catch (err) {
		const code = isRecord(err) ? err.code : undefined;
		if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
			throw err;
		}
	}
}
