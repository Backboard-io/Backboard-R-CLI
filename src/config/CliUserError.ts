export class CliUserError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliUserError";
	}
}

export function cliUserErrorMessage(error: unknown): string | null {
	return error instanceof CliUserError ? error.message : null;
}
