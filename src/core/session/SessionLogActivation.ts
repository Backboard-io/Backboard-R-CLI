export interface ActivatableSessionLog {
	activate(sessionId: string, filePath: string): Promise<void>;
}

export async function activateSessionLogs(input: {
	clientLog: ActivatableSessionLog;
	serverLog: ActivatableSessionLog;
	next: { sessionId: string; clientLog: string; serverLog: string };
	previous: { sessionId: string; clientLog: string; serverLog: string };
}): Promise<void> {
	try {
		await input.clientLog.activate(input.next.sessionId, input.next.clientLog);
		await input.serverLog.activate(input.next.sessionId, input.next.serverLog);
	} catch (error) {
		const rollback = await Promise.allSettled([
			input.clientLog.activate(
				input.previous.sessionId,
				input.previous.clientLog,
			),
			input.serverLog.activate(
				input.previous.sessionId,
				input.previous.serverLog,
			),
		]);
		const rollbackErrors = rollback.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (rollbackErrors.length > 0) {
			throw new AggregateError(
				[error, ...rollbackErrors],
				`Failed to rotate logs to session ${input.next.sessionId} and restore session ${input.previous.sessionId}.`,
			);
		}
		throw error;
	}
}
