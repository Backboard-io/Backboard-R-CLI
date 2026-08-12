export function shellPathLabel(cwd: string, home = process.env.HOME): string {
	if (!home) return cwd;
	if (cwd === home) return "~";
	if (cwd.startsWith(`${home}/`)) return `~/${cwd.slice(home.length + 1)}`;
	return cwd;
}

export function compactPathLabel(path: string, maxWidth: number): string {
	if (path.length <= maxWidth) return path;
	if (maxWidth <= 0) return "";
	if (maxWidth <= 3) return path.slice(-maxWidth);

	const parts = path.split("/").filter(Boolean);
	const last = parts.at(-1) ?? path;
	const prefix = path.startsWith("~/") ? "~" : "";
	const suffixParts: string[] = [];

	for (let index = parts.length - 1; index >= 0; index -= 1) {
		suffixParts.unshift(parts[index] ?? "");
		const candidate = prefix
			? `${prefix}/.../${suffixParts.join("/")}`
			: `.../${suffixParts.join("/")}`;
		if (candidate.length > maxWidth) {
			suffixParts.shift();
			break;
		}
	}

	const best =
		suffixParts.length > 0
			? prefix
				? `${prefix}/.../${suffixParts.join("/")}`
				: `.../${suffixParts.join("/")}`
			: `.../${last}`;
	if (best.length <= maxWidth) return best;
	return clipStart(last, maxWidth);
}

function clipStart(value: string, maxWidth: number): string {
	if (value.length <= maxWidth) return value;
	if (maxWidth <= 0) return "";
	if (maxWidth <= 3) return value.slice(-maxWidth);
	return `...${value.slice(-(maxWidth - 3))}`;
}
