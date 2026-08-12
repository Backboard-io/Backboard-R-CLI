export class LspServerUnavailableError extends Error {
	constructor(
		readonly serverId: string,
		message: string,
	) {
		super(message);
		this.name = "LspServerUnavailableError";
	}
}

export function isLspServerUnavailableError(
	error: unknown,
): error is LspServerUnavailableError {
	return error instanceof LspServerUnavailableError;
}
