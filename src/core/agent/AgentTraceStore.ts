import { writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { errorMessage } from "../../utils/errors.ts";
import { ensureDir } from "../../utils/fs.ts";
import type { RLMResult } from "./rlm/RLMTypes.ts";

export interface AgentTraceMeta {
	sessionId: string;
	toolCallId: string;
	mode: "worker" | "rlm";
	prompt: string;
	createdAt: string;
}

export interface AgentTracePaths {
	root: string;
	meta: string;
	clientLog: string;
	trajectory: string;
	error: string;
}

export class AgentTraceContext {
	constructor(
		private readonly input: {
			sessionId: string;
			sessionRoot: string;
			cwd: string;
			toolCallId?: string;
		},
	) {}

	forToolCall(toolCallId: string): AgentTraceContext {
		return new AgentTraceContext({
			...this.input,
			toolCallId,
		});
	}

	async createAgentTrace(input: {
		mode: "worker" | "rlm";
		prompt: string;
	}): Promise<AgentTraceStore | null> {
		if (!this.input.toolCallId) return null;

		const trace = new AgentTraceStore(
			this.input.sessionRoot,
			this.input.cwd,
			this.input.toolCallId,
		);
		await trace.init({
			sessionId: this.input.sessionId,
			toolCallId: this.input.toolCallId,
			mode: input.mode,
			prompt: input.prompt,
			createdAt: new Date().toISOString(),
		});
		return trace;
	}
}

export class AgentTraceStore {
	readonly paths: AgentTracePaths;

	constructor(
		sessionRoot: string,
		private readonly cwd: string,
		toolCallId: string,
	) {
		const root = join(sessionRoot, "agents", safePathPart(toolCallId));
		this.paths = {
			root,
			meta: join(root, "meta.json"),
			clientLog: join(root, "client.jsonl"),
			trajectory: join(root, "trajectory.json"),
			error: join(root, "error.json"),
		};
	}

	async init(meta: AgentTraceMeta): Promise<void> {
		await ensureDir(this.paths.root);
		await writeFile(this.paths.meta, JSON.stringify(meta, null, 2), "utf8");
	}

	async writeRLMResult(result: RLMResult): Promise<void> {
		await ensureDir(this.paths.root);
		await writeFile(
			this.paths.trajectory,
			JSON.stringify(
				{
					status: result.status,
					rounds: result.rounds,
					report: result.report,
					usage: result.usage,
					trajectory: result.trajectory,
				},
				null,
				2,
			),
			"utf8",
		);
	}

	async writeError(error: unknown): Promise<void> {
		await ensureDir(this.paths.root);
		await writeFile(
			this.paths.error,
			JSON.stringify(
				{
					message: errorMessage(error),
					stack: error instanceof Error ? error.stack : undefined,
					createdAt: new Date().toISOString(),
				},
				null,
				2,
			),
			"utf8",
		);
	}

	relativePath(path: string): string {
		return relative(this.cwd, path);
	}
}

function safePathPart(value: string): string {
	return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}
