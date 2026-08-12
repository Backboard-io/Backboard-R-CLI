import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const BACKBOARD_CONFIG_DIR_NAME = ".backboard";
export const MCP_CONFIG_FILE_NAME = "mcp.json";
export const HOOK_CONFIG_FILE_NAME = "hooks.json";
export const SESSION_DIR_NAME = "sessions";
export const WORKSPACE_CONFIG_FILE_NAME = "workspace.json";

export interface McpConfigPaths {
	project: string;
	user: string;
}

export interface HookConfigPaths {
	project: string;
	user: string;
}

export function findRepoRoot(cwd: string): string {
	let current = path.resolve(cwd);
	while (true) {
		if (existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return path.resolve(cwd);
		current = parent;
	}
}

export function qProjectConfigDir(cwd: string): string {
	return path.join(findRepoRoot(cwd), BACKBOARD_CONFIG_DIR_NAME);
}

export function qProjectWorkspaceId(cwd: string): string {
	const filePath = path.join(
		qProjectConfigDir(cwd),
		WORKSPACE_CONFIG_FILE_NAME,
	);
	const existing = readWorkspaceId(filePath);
	if (existing) {
		try {
			// Repair checkouts whose workspace.json predates gitignore handling.
			ensureWorkspaceGitignored(path.dirname(filePath));
		} catch {
			// Best-effort: an unwritable checkout still uses the stored id.
		}
		return existing;
	}

	const id = randomUUID();
	try {
		const dir = path.dirname(filePath);
		mkdirSync(dir, { recursive: true });
		writeFileSync(filePath, `${JSON.stringify({ id }, null, 2)}\n`, "utf8");
		ensureWorkspaceGitignored(dir);
		return id;
	} catch {
		// Unwritable checkout (EROFS/EACCES): stable id from the repo root path.
		return createHash("sha256")
			.update(findRepoRoot(cwd))
			.digest("hex")
			.slice(0, 32);
	}
}

function ensureWorkspaceGitignored(dir: string): void {
	const gitignorePath = path.join(dir, ".gitignore");
	let gitignore = "";
	if (existsSync(gitignorePath)) {
		gitignore = readFileSync(gitignorePath, "utf8");
	}
	if (gitignore.split(/\r?\n/).includes(WORKSPACE_CONFIG_FILE_NAME)) return;
	const prefix =
		gitignore && !gitignore.endsWith("\n") ? `${gitignore}\n` : gitignore;
	writeFileSync(
		gitignorePath,
		`${prefix}${WORKSPACE_CONFIG_FILE_NAME}\n`,
		"utf8",
	);
}

function readWorkspaceId(filePath: string): string | null {
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"id" in parsed &&
			typeof parsed.id === "string" &&
			parsed.id.trim()
		) {
			return parsed.id.trim();
		}
	} catch {
		return null;
	}
	return null;
}

export function qUserConfigDir(homeDir = os.homedir()): string {
	return path.join(homeDir, BACKBOARD_CONFIG_DIR_NAME);
}

export function qProjectMcpConfigPath(cwd: string): string {
	return path.join(qProjectConfigDir(cwd), MCP_CONFIG_FILE_NAME);
}

export function qUserMcpConfigPath(homeDir?: string): string {
	return path.join(qUserConfigDir(homeDir), MCP_CONFIG_FILE_NAME);
}

export function qProjectHookConfigPath(cwd: string): string {
	return path.join(qProjectConfigDir(cwd), HOOK_CONFIG_FILE_NAME);
}

export function qUserHookConfigPath(homeDir?: string): string {
	return path.join(qUserConfigDir(homeDir), HOOK_CONFIG_FILE_NAME);
}

export function qSessionDir(baseDir: string, sessionId: string): string {
	return path.join(
		baseDir,
		BACKBOARD_CONFIG_DIR_NAME,
		SESSION_DIR_NAME,
		sessionId,
	);
}
