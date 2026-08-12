import { spawn } from "node:child_process";
import { createServer, type RequestListener, type Server } from "node:http";
import os from "node:os";
import { treeSpawnOptions } from "../../utils/processTree.ts";

export async function listenOnLoopback(
	host: string,
	port: number,
	handler: RequestListener,
): Promise<Server> {
	return await new Promise<Server>((resolve, reject) => {
		const server = createServer(handler);
		const onError = (err: Error) => {
			server.off("listening", onListening);
			server.close();
			reject(err);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve(server);
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, host);
	});
}

export async function openDefaultBrowser(url: URL | string): Promise<void> {
	// Normalizing here is what makes escapeForCmd's precondition real: it
	// percent-encodes the spaces and quotes that would otherwise make libuv
	// quote the argument, and throws on input that is not a URL at all.
	const value = new URL(url).toString();
	const platform = os.platform();
	const command =
		platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
	const args =
		platform === "win32" ? ["/c", "start", "", escapeForCmd(value)] : [value];

	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, {
			...treeSpawnOptions(platform),
			stdio: "ignore",
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

/**
 * `cmd /c start` re-parses its command line, so `&` in an OAuth URL is read as
 * a command separator and everything after the first query parameter is lost.
 * Node only quotes arguments containing spaces, and re-quoting here just gets
 * quoted again — caret escaping is what cmd.exe actually honours.
 *
 * Precondition: `value` must contain no whitespace and no `"`. Caret is not an
 * escape character inside cmd's quoted regions, and libuv quotes any argument
 * holding a space, tab or quote — the carets would then arrive literally. Pass
 * a normalized `new URL(...).toString()`, never a raw string from the network.
 *
 * `%` stays in the set: undefined names like `%3A` pass through untouched, but
 * a defined one expands, so a hostile `%USERPROFILE%` in an authorize URL would
 * otherwise leak the value to whoever served that URL.
 */
export function escapeForCmd(value: string): string {
	return value.replace(/[&^|<>()%!]/g, (char) => `^${char}`);
}

export function isNodeError(value: unknown): value is NodeJS.ErrnoException {
	return value instanceof Error && "code" in value;
}
