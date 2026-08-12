#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_VERSION } from "../src/config/branding.ts";

// Cross-compiles the CLI for every platform the production install
// channel (app/routers/cli_installer.py) knows how to serve, names each
// artifact backboard-<version>-<platform>-<arch> (with .exe on Windows),
// writes a .sha256 sidecar, and stages everything in cli/dist-native/.
//
// deploy.sh rsyncs exactly those filename patterns into the AMI, and the
// API serves the highest semver per platform — so a prod push of a higher
// version transparently replaces whatever CLI is currently live, with no
// change to the download URL.
//
// Leak posture: we ship ONLY the compiled binaries. The TypeScript source
// tree is excluded from deploy.sh, builds are minified, and the external
// sourcemap Bun emits (full readable source) is deleted before staging. A
// secret-shape audit fails the build if a credential is ever baked in.

interface Target {
	// Bun --target value for cross compilation.
	bunTarget: string;
	// Platform slug used in the output filename + the API's _BINARY_RE.
	platform: string;
	// Windows artifacts must end in .exe for the API regex to match.
	exe: boolean;
}

const TARGETS: Target[] = [
	// macOS
	{ bunTarget: "bun-darwin-arm64", platform: "macos-arm64", exe: false },
	{ bunTarget: "bun-darwin-x64", platform: "macos-x64", exe: false },
	{
		bunTarget: "bun-darwin-x64-baseline",
		platform: "macos-x64-baseline",
		exe: false,
	},
	// Linux (glibc)
	{ bunTarget: "bun-linux-arm64", platform: "linux-arm64", exe: false },
	{ bunTarget: "bun-linux-x64", platform: "linux-x64", exe: false },
	{
		bunTarget: "bun-linux-x64-baseline",
		platform: "linux-x64-baseline",
		exe: false,
	},
	// Linux (musl: Alpine / Void)
	{
		bunTarget: "bun-linux-arm64-musl",
		platform: "linux-arm64-musl",
		exe: false,
	},
	{ bunTarget: "bun-linux-x64-musl", platform: "linux-x64-musl", exe: false },
	{
		bunTarget: "bun-linux-x64-musl-baseline",
		platform: "linux-x64-musl-baseline",
		exe: false,
	},
	// Windows
	{ bunTarget: "bun-windows-x64", platform: "windows-x64", exe: true },
	{
		bunTarget: "bun-windows-x64-baseline",
		platform: "windows-x64-baseline",
		exe: true,
	},
];

// Credential shapes that must never be baked into a shipped binary. Kept
// in sync with the legacy Nuitka pipeline's SECRET_PATTERNS. We do NOT
// audit for prompt/URL text here: Bun keeps string literals in plaintext,
// so that would always fail without a separate obfuscation pass — the real
// danger is a leaked API key, which these patterns catch.
const SECRET_PATTERNS = [
	// Backboard API key shape (e.g. the espr_… keys in dev .env files). Guards
	// against a build accidentally baking a real key into the shipped binary.
	"espr_[a-zA-Z0-9]{20,}",
	"sk-[a-zA-Z0-9]{32,}",
	"sk-ant-[a-zA-Z0-9_-]{32,}",
	"AKIA[0-9A-Z]{16}",
	"xox[abprs]-[0-9]+-[0-9]+-[0-9a-zA-Z]+",
	"ghp_[a-zA-Z0-9]{36,}",
	"github_pat_[a-zA-Z0-9_]{60,}",
];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(scriptDir, "..");
const entrypoint = join(cliRoot, "src/entrypoints/cli.tsx");
const outDir = resolve(cliRoot, "..", "cli", "dist-native");

async function sha256(path: string): Promise<string> {
	const buf = await readFile(path);
	return createHash("sha256").update(buf).digest("hex");
}

// Bun emits an external sourcemap (<entry>.js.map) next to the outfile even
// with --sourcemap=none. It contains the full readable source, so we remove
// every .map (and any stray .js) from the staging dir after each build.
async function purgeSourceArtifacts(): Promise<void> {
	for (const f of await readdir(outDir)) {
		if (f.endsWith(".map") || f.endsWith(".js")) {
			await rm(join(outDir, f), { force: true });
		}
	}
}

async function auditSecrets(path: string, name: string): Promise<void> {
	const proc = Bun.spawn(["strings", path], {
		stdout: "pipe",
		stderr: "ignore",
	});
	const dumped = await new Response(proc.stdout).text();
	await proc.exited;
	const rx = new RegExp(SECRET_PATTERNS.join("|"));
	const hits = dumped
		.split("\n")
		.filter((line) => rx.test(line))
		.slice(0, 10);
	if (hits.length > 0) {
		console.error(`    ✗ secret leak detected in ${name}:`);
		for (const h of hits) console.error(`        ${h}`);
		throw new Error(`refusing to ship ${name}: secret-shape match`);
	}
}

async function buildTarget(target: Target): Promise<string> {
	const name = `backboard-${APP_VERSION}-${target.platform}${target.exe ? ".exe" : ""}`;
	const outfile = join(outDir, name);

	const command = [
		"bun",
		"build",
		"--compile",
		`--target=${target.bunTarget}`,
		"--minify",
		"--sourcemap=none",
		"--outfile",
		outfile,
		entrypoint,
	];

	const oauthClientId = process.env.BACKBOARD_OAUTH_CLIENT_ID?.trim();
	if (oauthClientId) {
		command.splice(
			4,
			0,
			"--define",
			`process.env.BACKBOARD_OAUTH_CLIENT_ID=${JSON.stringify(oauthClientId)}`,
		);
	}

	console.log(`\n==> building ${name} (${target.bunTarget})`);
	const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
	const code = await child.exited;
	if (code !== 0) {
		throw new Error(`build failed for ${target.platform} (exit ${code})`);
	}

	await purgeSourceArtifacts();
	await auditSecrets(outfile, name);

	const digest = await sha256(outfile);
	// Match the `sha256sum <file>` sidecar format the existing pipeline
	// emits so nothing downstream has to special-case our checksums.
	await writeFile(`${outfile}.sha256`, `${digest}  ${name}\n`);
	console.log(`    ${name}`);
	console.log(`    sha256: ${digest}`);
	return name;
}

async function main(): Promise<void> {
	console.log(`Backboard CLI release build v${APP_VERSION}`);
	console.log(`  output: ${outDir}`);

	await mkdir(outDir, { recursive: true });

	// Clean previous artifacts so a prod push never ships a stale slice
	// or a leftover binary from the deprecated Python pipeline.
	for (const f of await readdir(outDir)) {
		if (f.startsWith("backboard-")) {
			await rm(join(outDir, f), { force: true });
		}
	}

	const built: string[] = [];
	for (const target of TARGETS) {
		built.push(await buildTarget(target));
	}

	// Final guard: nothing but compiled binaries + checksums may remain.
	await purgeSourceArtifacts();
	const stray = (await readdir(outDir)).filter(
		(f) => !f.startsWith("backboard-"),
	);
	if (stray.length > 0) {
		console.warn(
			`\n  note: non-binary entries remain in cli/dist-native (not shipped by deploy.sh): ${stray.join(", ")}`,
		);
	}

	console.log(`\nDone. Staged ${built.length} binaries in cli/dist-native/:`);
	for (const name of built) console.log(`  ${name}`);
	console.log(
		"\nNext: run ./deploy.sh from the repo root to push to production.",
	);
}

await main();
