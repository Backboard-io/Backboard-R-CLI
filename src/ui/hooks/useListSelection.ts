import type { Key } from "ink";
import { useEffect, useState } from "react";

export interface ListSelection {
	index: number;
	setIndex: React.Dispatch<React.SetStateAction<number>>;
	/** Feed useInput events through this; returns true when consumed. */
	onInput: (input: string, key: Key) => boolean;
}

/**
 * Wrap-around ↑/↓ selection for simple (non-windowed) lists, with optional
 * 1-9 digit jump. Windowed lists (Picker) keep using movePickerSelection.
 */
export function useListSelection(
	count: number,
	opts: { digitJump?: boolean } = {},
): ListSelection {
	const [index, setIndex] = useState(0);
	useEffect(() => {
		if (count > 0 && index >= count) setIndex(count - 1);
	}, [count, index]);

	const onInput = (input: string, key: Key): boolean => {
		if (count === 0) return false;
		if (key.upArrow) {
			setIndex((current) => (current <= 0 ? count - 1 : current - 1));
			return true;
		}
		if (key.downArrow) {
			setIndex((current) => (current >= count - 1 ? 0 : current + 1));
			return true;
		}
		if (opts.digitJump && /^[1-9]$/.test(input)) {
			const target = Number(input) - 1;
			if (target < count) {
				setIndex(target);
				return true;
			}
		}
		return false;
	};

	return { index, setIndex, onInput };
}
