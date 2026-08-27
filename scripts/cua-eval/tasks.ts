/**
 * Tier-1 computer-use tasks for a Daytona XFCE sandbox. Each task follows the
 * OSWorld evaluator pattern: `setup` commands prepare state, the agent gets a
 * natural-language `instruction`, and `check` inspects the final machine state
 * through the sandbox process API (never through the model).
 */
export interface EvalSandbox {
	exec(
		command: string,
		timeoutSeconds?: number,
	): Promise<{ exitCode: number; output: string }>;
}

export interface EvalTask {
	id: string;
	group: "editor" | "settings" | "web" | "multi";
	instruction: string;
	/** Shell commands run before the agent starts; `{{browser}}` is replaced. */
	setup?: string[];
	/** Apps the sandbox must have; missing ones are installed once per sandbox. */
	packages?: string[];
	check: (sandbox: EvalSandbox) => Promise<{ pass: boolean; detail: string }>;
	maxRounds?: number;
}

const FORM_SERVER = `
mkdir -p /tmp/cua-web && cat > /tmp/cua-web/index.html <<'HTML'
<!doctype html><title>Newsletter signup</title>
<h1>Newsletter signup</h1>
<form method="post" action="/submit">
<label>Name <input name="name" id="name"></label><br>
<label>Email <input name="email" id="email"></label><br>
<label><input type="checkbox" name="weekly" id="weekly"> Weekly digest</label><br>
<button type="submit" id="submit">Subscribe</button>
</form>
HTML
cat > /tmp/cua-web/server.py <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header("Content-Type","text/html"); self.end_headers()
        self.wfile.write(open("/tmp/cua-web/index.html","rb").read())
    def do_POST(self):
        n=int(self.headers.get("Content-Length","0")); body=self.rfile.read(n).decode()
        open("/tmp/cua-web/submissions.log","a").write(body+"\\n")
        self.send_response(200); self.send_header("Content-Type","text/html"); self.end_headers()
        self.wfile.write(b"<h1>Thanks, you are subscribed.</h1>")
    def log_message(self,*a): pass
HTTPServer(("127.0.0.1",8765),H).serve_forever()
PY
(nohup python3 /tmp/cua-web/server.py >/dev/null 2>&1 &)
sleep 0.5
`;

async function fileEquals(
	sandbox: EvalSandbox,
	path: string,
	expected: string,
): Promise<{ pass: boolean; detail: string }> {
	const result = await sandbox.exec(`cat ${path} 2>/dev/null`);
	const withoutFinalNewline = (value: string): string =>
		value.endsWith("\r\n")
			? value.slice(0, -2)
			: value.endsWith("\n")
				? value.slice(0, -1)
				: value;
	const actual = withoutFinalNewline(result.output);
	const wanted = withoutFinalNewline(expected);
	return {
		pass: actual === wanted,
		detail: `expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual.slice(0, 120))}`,
	};
}

export const EVAL_TASKS: EvalTask[] = [
	{
		id: "editor-save-hello",
		group: "editor",
		packages: ["mousepad"],
		instruction:
			"Open the text editor, type exactly `hello from backboard` and save the file as /home/daytona/hello.txt.",
		setup: ["rm -f /home/daytona/hello.txt"],
		check: (sb) =>
			fileEquals(sb, "/home/daytona/hello.txt", "hello from backboard"),
	},
	{
		id: "editor-append-line",
		group: "editor",
		packages: ["mousepad"],
		instruction:
			"The file /home/daytona/notes.txt is open in the text editor. Add a new last line that says `- buy milk` and save it.",
		setup: [
			"printf 'todo:\\n- call mom\\n' > /home/daytona/notes.txt",
			"(nohup mousepad /home/daytona/notes.txt >/dev/null 2>&1 &)",
			"sleep 1.5",
		],
		check: async (sb) => {
			const result = await sb.exec("cat /home/daytona/notes.txt");
			const lines = result.output.trim().split("\n");
			return {
				pass:
					lines.at(-1)?.trim() === "- buy milk" &&
					lines[1]?.trim() === "- call mom",
				detail: JSON.stringify(result.output),
			};
		},
	},
	{
		id: "editor-replace-word",
		group: "editor",
		packages: ["mousepad"],
		instruction:
			"In the text editor window that is open, change the word `Tuesday` to `Friday` and save the file.",
		setup: [
			"printf 'The meeting is on Tuesday at noon.\\n' > /home/daytona/meeting.txt",
			"(nohup mousepad /home/daytona/meeting.txt >/dev/null 2>&1 &)",
			"sleep 1.5",
		],
		check: (sb) =>
			fileEquals(
				sb,
				"/home/daytona/meeting.txt",
				"The meeting is on Friday at noon.",
			),
	},
	{
		id: "terminal-create-dir",
		group: "editor",
		instruction:
			"Open a terminal window and create a directory named `reports` in the home folder using the shell.",
		setup: ["rm -rf /home/daytona/reports"],
		check: async (sb) => {
			const result = await sb.exec(
				"test -d /home/daytona/reports && echo yes || echo no",
			);
			return {
				pass: result.output.trim() === "yes",
				detail: result.output.trim(),
			};
		},
	},
	{
		id: "settings-dark-theme",
		group: "settings",
		instruction:
			"Open the desktop Appearance settings and switch the window style/theme to a dark one (any theme whose name contains `dark`).",
		setup: ["xfconf-query -c xsettings -p /Net/ThemeName -s Adwaita || true"],
		check: async (sb) => {
			const result = await sb.exec(
				"xfconf-query -c xsettings -p /Net/ThemeName",
			);
			return {
				pass: /dark/i.test(result.output),
				detail: `theme is ${result.output.trim()}`,
			};
		},
	},
	{
		id: "settings-wallpaper-color",
		group: "settings",
		instruction:
			"Using the desktop settings GUI, set the desktop background to a solid color instead of an image.",
		setup: [],
		check: async (sb) => {
			const listed = await sb.exec(
				`xfconf-query -c xfce4-desktop -l -v 2>/dev/null | grep -i image-style || grep -o 'image-style" type="int" value="[0-9]*"' ~/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-desktop.xml 2>/dev/null || echo none`,
			);
			return {
				pass: /image-style[^0-9]+0\b/.test(listed.output),
				detail: listed.output.trim().slice(0, 200) || "none",
			};
		},
	},
	{
		id: "web-form-submit",
		group: "web",
		packages: ["browser"],
		instruction:
			"A signup page is open in the browser. Fill in the name `Ada Lovelace`, the email `ada@example.com`, tick the weekly digest box, and submit the form.",
		setup: [
			FORM_SERVER,
			"rm -f /tmp/cua-web/submissions.log",
			"(nohup {{browser}} http://127.0.0.1:8765/ >/dev/null 2>&1 &)",
			"sleep 4",
		],
		check: async (sb) => {
			const result = await sb.exec(
				"cat /tmp/cua-web/submissions.log 2>/dev/null",
			);
			const submissions = result.output
				.split("\n")
				.filter((body) => body.trim().length > 0);
			const body = submissions[0] ?? "";
			const submitted =
				submissions.length === 1 &&
				body.includes("name=Ada+Lovelace") &&
				body.includes("email=ada%40example.com") &&
				body.includes("weekly=on");
			return {
				pass: submitted,
				detail: result.output.slice(0, 200) || "no submission",
			};
		},
	},
	{
		id: "web-read-and-record",
		group: "web",
		packages: ["browser"],
		instruction:
			"The browser shows a page with a headline. Read the headline and save it, exactly as written, to /home/daytona/headline.txt using any method you like.",
		setup: [
			FORM_SERVER,
			"(nohup {{browser}} http://127.0.0.1:8765/ >/dev/null 2>&1 &)",
			"sleep 4",
			"rm -f /home/daytona/headline.txt",
		],
		check: (sb) =>
			fileEquals(sb, "/home/daytona/headline.txt", "Newsletter signup"),
	},
	{
		id: "multi-editor-to-terminal",
		group: "multi",
		packages: ["mousepad"],
		instruction:
			"Open the text editor, write the single line `echo multi ok > /home/daytona/multi.txt`, save it as /home/daytona/run.sh, then open a terminal and run it with `sh /home/daytona/run.sh`.",
		setup: ["rm -f /home/daytona/run.sh /home/daytona/multi.txt"],
		check: (sb) => fileEquals(sb, "/home/daytona/multi.txt", "multi ok"),
	},
	{
		id: "multi-copy-between-editors",
		group: "multi",
		packages: ["mousepad"],
		instruction:
			"Two editor windows are open: `source.txt` and `target.txt`. Copy the entire contents of source.txt into target.txt (replacing what is there) and save target.txt.",
		setup: [
			"printf 'alpha beta gamma\\n' > /home/daytona/source.txt",
			"printf 'placeholder\\n' > /home/daytona/target.txt",
			"(nohup mousepad /home/daytona/source.txt >/dev/null 2>&1 &)",
			"sleep 1",
			"(nohup mousepad /home/daytona/target.txt >/dev/null 2>&1 &)",
			"sleep 1.5",
		],
		check: (sb) =>
			fileEquals(sb, "/home/daytona/target.txt", "alpha beta gamma"),
	},
];

/** Distros differ on the browser package; the first installable one wins. */
export const BROWSER_CANDIDATES = [
	"firefox-esr",
	"firefox",
	"epiphany-browser",
	"chromium",
];

export const REQUIRED_PACKAGES = [
	...new Set(EVAL_TASKS.flatMap((task) => task.packages ?? [])),
	"xfce4-terminal",
	"xdotool",
];
