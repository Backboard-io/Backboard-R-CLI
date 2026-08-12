import { useLayoutEffect, useRef, useState } from "react";
import {
	CLEAR_VISIBLE_SCREEN,
	RESIZE_SETTLE_DELAY_MS,
} from "./ResizeStabilizer.constants.ts";
import type {
	ResizeStabilizerOptions,
	ResizeStabilizerState,
} from "./ResizeStabilizer.types.ts";
import type { TerminalSize } from "./TerminalSizeContext.types.ts";

export function useResizeStabilizer(
	size: TerminalSize,
	options: ResizeStabilizerOptions,
): ResizeStabilizerState {
	const sizeKey = `${size.columns}x${size.rows}`;
	const observedSizeKey = useRef(sizeKey);
	const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [state, setState] = useState<ResizeStabilizerState>({
		isResizing: false,
		resizeEpoch: 0,
	});

	const sizeChanged = observedSizeKey.current !== sizeKey;
	if (sizeChanged) {
		observedSizeKey.current = sizeKey;
	}
	const changedSizeKey = sizeChanged ? sizeKey : null;

	useLayoutEffect(() => {
		if (!changedSizeKey) return;
		if (options.isTerminal) {
			options.write(CLEAR_VISIBLE_SCREEN);
		}
		setState((current) =>
			current.isResizing ? current : { ...current, isResizing: true },
		);
		if (resizeTimer.current) {
			clearTimeout(resizeTimer.current);
		}
		resizeTimer.current = setTimeout(() => {
			resizeTimer.current = null;
			setState((current) => ({
				isResizing: false,
				resizeEpoch: current.resizeEpoch + 1,
			}));
		}, RESIZE_SETTLE_DELAY_MS);
	}, [changedSizeKey, options.isTerminal, options.write]);

	useLayoutEffect(() => {
		return () => {
			if (resizeTimer.current) {
				clearTimeout(resizeTimer.current);
				resizeTimer.current = null;
			}
		};
	}, []);

	return {
		isResizing: state.isResizing || sizeChanged,
		resizeEpoch: state.resizeEpoch,
	};
}
