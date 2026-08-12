import { spawn } from "node:child_process";

export function run(
	command: string,
	args: string[],
	signal: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: "ignore", signal });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`${command} exited with code ${code}`));
		});
	});
}

export function runWithOutput(
	command: string,
	args: string[],
	signal: AbortSignal,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { signal });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve(Buffer.concat(stdout).toString("utf8"));
				return;
			}
			const message = Buffer.concat(stderr).toString("utf8").trim();
			reject(
				new Error(
					message
						? `${command} exited with code ${code}: ${message}`
						: `${command} exited with code ${code}`,
				),
			);
		});
	});
}
