import { Box, Text } from "ink";
import type React from "react";
import type { TodoItem } from "../../core/bus/events.ts";
import { pluralize } from "../../utils/string.ts";
import { theme } from "../theme/theme.ts";
import {
	TODO_PANEL_COMPACT_HEIGHT,
	TODO_PANEL_MAX_ITEMS,
	TODO_PANEL_MEDIUM_HEIGHT,
	TODO_PANEL_MEDIUM_ITEMS,
	TODO_PANEL_SHORT_HEIGHT,
	TODO_PANEL_SHORT_ITEMS,
} from "./TodoPanel.constants.ts";

interface Props {
	todos: TodoItem[];
	display?: TodoPanelDisplay;
}

export interface TodoPanelDisplay {
	compact: boolean;
	maxItems: number;
}

const MARK: Record<TodoItem["status"], string> = {
	pending: "[ ]",
	in_progress: "[>]",
	completed: "[x]",
};

export function TodoPanel({
	todos,
	display,
}: Props): React.ReactElement | null {
	if (!shouldShowTodoPanel(todos)) return null;
	const mode = display ?? { compact: false, maxItems: TODO_PANEL_MAX_ITEMS };
	if (mode.compact) return <CompactTodoPanel todos={todos} />;
	const visible = visibleTodoItems(todos, mode.maxItems);

	return (
		<Box
			flexDirection="column"
			marginTop={1}
			borderStyle="round"
			borderColor={theme.accentBright}
			paddingX={1}
		>
			<Text color={theme.accentBright} bold>
				Todos
			</Text>
			{visible.items.map((todo) => (
				<Text
					key={todo.id}
					color={todo.status === "completed" ? theme.subtle : theme.text}
					wrap="truncate-end"
				>
					{MARK[todo.status]} {todo.content}
				</Text>
			))}
			{visible.hiddenCount > 0 ? (
				<Text color={theme.subtle} wrap="truncate-end">
					... {visible.hiddenCount} more{" "}
					{pluralize(visible.hiddenCount, "todo")}
				</Text>
			) : null}
		</Box>
	);
}

export function shouldShowTodoPanel(todos: readonly TodoItem[]): boolean {
	return todos.length > 0;
}

function CompactTodoPanel({
	todos,
}: {
	todos: readonly TodoItem[];
}): React.ReactElement {
	return (
		<Box marginTop={1}>
			<Text color={theme.accentBright} bold wrap="truncate-end">
				Todos {compactTodoSummary(todos)}
			</Text>
		</Box>
	);
}

export function visibleTodoItems(
	todos: readonly TodoItem[],
	limit = TODO_PANEL_MAX_ITEMS,
): { items: TodoItem[]; hiddenCount: number } {
	if (todos.length <= limit) return { items: [...todos], hiddenCount: 0 };
	const activeIndex = todos.findIndex((todo) => todo.status === "in_progress");
	if (activeIndex < 0 || activeIndex < limit) {
		return {
			items: todos.slice(0, limit),
			hiddenCount: todos.length - limit,
		};
	}
	const active = todos[activeIndex];
	if (!active) {
		return {
			items: todos.slice(0, limit),
			hiddenCount: todos.length - limit,
		};
	}
	const headCount = Math.max(0, limit - 1);
	return {
		items: [...todos.slice(0, headCount), active],
		hiddenCount: todos.length - headCount - 1,
	};
}

export function todoPanelDisplayForTerminalHeight(
	height: number,
): TodoPanelDisplay {
	if (height <= TODO_PANEL_COMPACT_HEIGHT) {
		return { compact: true, maxItems: 0 };
	}
	if (height <= TODO_PANEL_SHORT_HEIGHT) {
		return { compact: false, maxItems: TODO_PANEL_SHORT_ITEMS };
	}
	if (height <= TODO_PANEL_MEDIUM_HEIGHT) {
		return { compact: false, maxItems: TODO_PANEL_MEDIUM_ITEMS };
	}
	return { compact: false, maxItems: TODO_PANEL_MAX_ITEMS };
}

export function compactTodoSummary(todos: readonly TodoItem[]): string {
	const active = todos.find((todo) => todo.status === "in_progress");
	if (active) {
		// Count only work still outstanding; completed siblings stay in the
		// list (kept-completed lifecycle) but shouldn't inflate "+N more to do".
		const remaining = todos.filter((todo) => todo.status === "pending").length;
		return `[>] ${active.content}${remaining > 0 ? ` (+${remaining})` : ""}`;
	}

	const completed = todos.filter((todo) => todo.status === "completed").length;
	const pending = todos.filter((todo) => todo.status === "pending").length;
	if (pending > 0) return `${pending} pending, ${completed} done`;
	return `${completed} done`;
}
