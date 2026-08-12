// Terminal background detection. Cascade: env override → OSC 11 query →
// COLORFGBG → default. The OSC 11 reply is read off stdin and a trailing DA1
// query marks its end, so we consume every byte before Ink mounts.

export type BgSource = "env" | "osc11" | "colorfgbg" | "default";
export type BgResult = { hex: string; source: BgSource };

/** Wrap an escape sequence so tmux/screen forward it to the host terminal. */
function wrapForMultiplexer(seq: string): string {
	if (process.env.TMUX) {
		return `\x1bPtmux;${seq.split("\x1b").join("\x1b\x1b")}\x1b\\`;
	}
	if (process.env.TERM?.startsWith("screen")) return `\x1bP${seq}\x1b\\`;
	return seq;
}

/** Parse an OSC 11 reply ("rgb:RRRR/GGGG/BBBB") to "#rrggbb" (high byte). */
function parseOsc11(reply: string): string | null {
	const m = /rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(
		reply,
	);
	if (!m) return null;
	const hi = (h: string | undefined) => (h ?? "0").padStart(2, "0").slice(0, 2);
	return `#${hi(m[1])}${hi(m[2])}${hi(m[3])}`;
}

/** Has the DA1 reply (ESC [ ? ... c) arrived? It marks the end of the response. */
function hasDa1Reply(buf: string): boolean {
	const start = buf.indexOf("\x1b[?");
	return start !== -1 && /^[0-9;]*c/.test(buf.slice(start + 3));
}

/** Query true background via OSC 11 on process.stdin, restoring it afterward. */
function queryOsc11(timeoutMs: number): Promise<string | null> {
	return new Promise((resolve) => {
		const { stdin, stdout } = process;
		if (
			!stdin.isTTY ||
			!stdout.isTTY ||
			typeof stdin.setRawMode !== "function"
		) {
			return resolve(null);
		}

		const wasRaw = stdin.isRaw;
		let settled = false;
		let acc = "";
		let timer: ReturnType<typeof setTimeout>;

		function finish(val: string | null): void {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			stdin.removeListener("data", onData);
			try {
				stdin.setRawMode(wasRaw);
			} catch {}
			// Don't pause() — under Bun it emits stdin 'end' and Ink then exits.
			resolve(val);
		}
		function onData(chunk: Buffer | string): void {
			acc += typeof chunk === "string" ? chunk : chunk.toString("latin1");
			if (hasDa1Reply(acc)) finish(parseOsc11(acc));
		}

		stdin.setRawMode(true);
		stdin.resume();
		stdin.on("data", onData);
		timer = setTimeout(() => finish(parseOsc11(acc)), timeoutMs);
		try {
			stdout.write(wrapForMultiplexer("\x1b]11;?\x07\x1b[c"));
		} catch {
			finish(null);
		}
	});
}

/** Manual override for terminals that can't be probed (GNU screen, conhost).
 *  TERMINAL_BG=light | dark | #rrggbb | #rgb */
function fromEnvOverride(): string | null {
	const v = process.env.TERMINAL_BG?.trim().toLowerCase();
	if (!v) return null;
	if (v === "light") return "#ffffff";
	if (v === "dark") return "#000000";
	const hex = v.replace(/^#/, "");
	if (/^[0-9a-f]{6}$/.test(hex)) return `#${hex}`;
	if (/^[0-9a-f]{3}$/.test(hex)) {
		return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
	}
	return null;
}

/** COLORFGBG="15;0" → bg palette index → rough black/white. */
function fromColorFgBg(): string | null {
	const v = process.env.COLORFGBG;
	if (!v) return null;
	const bg = Number(v.split(";").pop());
	if (Number.isNaN(bg)) return null;
	return bg === 7 || bg >= 9 ? "#ffffff" : "#000000";
}

/** Resolve the terminal background, falling back to `fallback`. */
export async function detectTerminalBg(
	fallback: string,
	timeoutMs = 200,
): Promise<BgResult> {
	const override = fromEnvOverride();
	if (override) return { hex: override, source: "env" };
	const real = await queryOsc11(timeoutMs);
	if (real) return { hex: real, source: "osc11" };
	const guess = fromColorFgBg();
	if (guess) return { hex: guess, source: "colorfgbg" };
	return { hex: fallback, source: "default" };
}
