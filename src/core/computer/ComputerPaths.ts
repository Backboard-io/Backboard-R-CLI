import { homedir } from "node:os";
import { join } from "node:path";
import { ensureDir } from "../../utils/fs.ts";

export class ComputerPaths {
	constructor(private readonly sessionId: string) {}

	get screenshotDir(): string {
		return join(homedir(), ".backboard", "screenshots", this.sessionId);
	}

	async nextScreenshotPath(now = new Date()): Promise<string> {
		await ensureDir(this.screenshotDir);
		const stamp = now
			.toISOString()
			.replaceAll(":", "")
			.replaceAll(".", "")
			.replace("T", "_")
			.replace("Z", "");
		return join(this.screenshotDir, `screen_${stamp}.png`);
	}
}
