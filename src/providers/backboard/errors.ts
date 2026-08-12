export class BackboardError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly body: unknown,
	) {
		super(message);
		this.name = "BackboardError";
	}
}

export class BackboardTransportError extends Error {
	constructor(
		message: string,
		readonly endpoint: string,
		readonly phase: "request" | "stream",
		readonly originalError: unknown,
	) {
		super(message);
		this.name = "BackboardTransportError";
	}
}
