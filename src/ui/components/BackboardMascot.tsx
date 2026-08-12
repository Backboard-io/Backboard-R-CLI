import { Box, Text } from "ink";
import type React from "react";
import { theme } from "../theme/theme.ts";
import { BACKBOARD_MASCOT_PATTERN } from "./TerminalComponents.constants.ts";

// Background fills (not block glyphs) so the mascot is gapless on every terminal.
function mascotRows(): Array<{ id: string; line: string }> {
	const rows: Array<{ id: string; line: string }> = [];
	for (const entry of BACKBOARD_MASCOT_PATTERN) {
		const count = Math.max(1, Math.round(entry.height));
		for (let i = 0; i < count; i += 1) {
			rows.push({ id: `${entry.id}-${i}`, line: entry.line });
		}
	}
	return rows;
}

const ROWS = mascotRows();
const WIDTH = Math.max(...ROWS.map((row) => row.line.length));
const isFilled = (line: string, col: number) => (line[col] ?? " ") === "#";

export function BackboardMascot(): React.ReactElement {
	return (
		<Box flexDirection="column" justifyContent="center">
			{ROWS.map((row) => (
				<MascotRow key={row.id} line={row.line} />
			))}
		</Box>
	);
}

function MascotRow({ line }: { line: string }): React.ReactElement {
	const runs: Array<{ filled: boolean; width: number; at: number }> = [];
	for (let col = 0; col < WIDTH; col += 1) {
		const filled = isFilled(line, col);
		const last = runs.at(-1);
		if (last && last.filled === filled) last.width += 1;
		else runs.push({ filled, width: 1, at: col });
	}
	return (
		<Box>
			{runs.map((run) => (
				<Text
					key={`c-${run.at}`}
					backgroundColor={run.filled ? theme.accentBright : undefined}
				>
					{" ".repeat(run.width)}
				</Text>
			))}
		</Box>
	);
}
