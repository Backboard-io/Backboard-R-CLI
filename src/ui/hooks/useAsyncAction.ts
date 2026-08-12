import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../../utils/errors.ts";

export interface AsyncAction {
	running: boolean;
	/** Spinner label for the in-flight task, null while idle. */
	label: string | null;
	error: string | null;
	setError: (error: string | null) => void;
	run: (label: string, task: (signal: AbortSignal) => Promise<void>) => void;
	/** Aborts the in-flight task, if any. */
	cancel: () => void;
}

/**
 * The submitting/label/abort/error state shared by action panels. `run`
 * ignores calls while a task is in flight; errors from aborted tasks are
 * swallowed; the in-flight task is aborted on unmount.
 */
export function useAsyncAction(): AsyncAction {
	const [running, setRunning] = useState(false);
	const [label, setLabel] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);

	useEffect(() => () => abortRef.current?.abort(), []);

	const run = (
		nextLabel: string,
		task: (signal: AbortSignal) => Promise<void>,
	): void => {
		if (running) return;
		const controller = new AbortController();
		abortRef.current = controller;
		setRunning(true);
		setLabel(nextLabel);
		setError(null);
		task(controller.signal)
			.catch((err) => {
				if (!controller.signal.aborted) setError(errorMessage(err));
			})
			.finally(() => {
				if (abortRef.current === controller) abortRef.current = null;
				setRunning(false);
				setLabel(null);
			});
	};

	return {
		running,
		label,
		error,
		setError,
		run,
		cancel: () => abortRef.current?.abort(),
	};
}
