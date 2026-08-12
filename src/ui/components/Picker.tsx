import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type React from "react";
import { useRef, useState } from "react";
import { errorMessage } from "../../utils/errors.ts";
import { padColumn } from "../../utils/string.ts";
import { useTerminalSize } from "../hooks/TerminalSizeContext.tsx";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { theme } from "../theme/theme.ts";
import { ErrorLine } from "./ErrorLine.tsx";
import { hintFooterText } from "./HintFooter.tsx";
import { Panel } from "./Panel.tsx";
import { SelectCaret } from "./SelectRow.tsx";
import { Spinner } from "./Spinner.tsx";

const VISIBLE_ITEMS = 12;
const DEFAULT_WIDTH = 80;
const COLUMN_GAP = 2;
const ROW_PREFIX_WIDTH = 2;
const HORIZONTAL_PADDING_WIDTH = 4;
const MIN_DESC_WIDTH = 8;

export interface PickerSelection {
	itemIndex: number;
	windowStart: number;
}

export type PickerMove = "up" | "down" | "pageUp" | "pageDown";

export interface PickerItem<T> {
	id: string;
	name: string;
	nameColor?: string;
	status?: string;
	statusColor?: string;
	badge?: string;
	badgeColor?: string;
	description?: string;
	detail?: string;
	disabledReason?: string;
	spacingBefore?: boolean;
	value: T;
}

export interface PickerTab<T> {
	id: string;
	label: string;
	items: PickerItem<T>[];
	error?: string;
	emptyLabel?: string;
}

interface ColumnLayout {
	nameWidth: number;
	statusWidth: number;
	descWidth: number;
	badgeWidth: number;
	badgeOffset: number;
}

interface Props<T> {
	title: string;
	subtitle?: string;
	tabs: PickerTab<T>[];
	onSelect: (item: T, signal: AbortSignal) => Promise<void> | void;
	onCancel: () => void;
	emptyLabel: string;
	selectingLabel?: string;
	showSearch?: boolean;
	initialItemId?: string;
}

export function Picker<T>({
	title,
	subtitle,
	tabs,
	onSelect,
	onCancel,
	emptyLabel,
	selectingLabel,
	showSearch = true,
	initialItemId,
}: Props<T>): React.ReactElement {
	const uiTheme = useTheme();
	const { columns } = useTerminalSize();
	const [error, setError] = useState<string | null>(null);
	const initialPosition = initialPickerPosition(tabs, initialItemId);
	const [tabIndex, setTabIndex] = useState(initialPosition.tabIndex);
	const [selection, setSelection] = useState<PickerSelection>(
		resetPickerSelection(initialPosition.itemIndex),
	);
	const [selecting, setSelecting] = useState(false);
	const [search, setSearch] = useState("");
	const selectAbort = useRef<AbortController | null>(null);

	const safeTabIndex = Math.min(tabIndex, Math.max(0, tabs.length - 1));
	const activeTab = tabs[safeTabIndex] ?? null;
	const items = filterItems(activeTab?.items ?? [], showSearch ? search : "");
	const { itemIndex: safeItemIndex, windowStart: start } =
		normalizePickerSelection(selection, items.length);
	const visible = items.slice(start, start + VISIBLE_ITEMS);
	const end = Math.min(start + visible.length, items.length);
	const hasPages = items.length > VISIBLE_ITEMS;
	const hasTabs = tabs.length > 1;

	const width = columns > 0 ? columns : DEFAULT_WIDTH;
	const layout = computeColumnLayout(items, visible, width);

	const selectCurrentItem = (): void => {
		if (selecting) return;
		const item = items[safeItemIndex];
		if (!item) return;
		if (item.disabledReason) {
			setError(item.disabledReason);
			return;
		}
		const controller = new AbortController();
		selectAbort.current = controller;
		setSelecting(true);
		setError(null);
		Promise.resolve(onSelect(item.value, controller.signal))
			.catch((err) => {
				if (controller.signal.aborted) return;
				setError(errorMessage(err));
			})
			.finally(() => {
				if (selectAbort.current === controller) {
					selectAbort.current = null;
					setSelecting(false);
				}
			});
	};

	const moveTab = (delta: number): void => {
		setTabIndex((current) => (current + delta + tabs.length) % tabs.length);
		setSelection(resetPickerSelection());
	};

	const updateSearch = (value: string): void => {
		setSearch(value);
		setSelection(resetPickerSelection());
	};

	useInput((_input, key) => {
		if (selecting) {
			if (key.escape) selectAbort.current?.abort();
			return;
		}
		if (key.escape) {
			if (error) setError(null);
			else if (showSearch && search) updateSearch("");
			else onCancel();
			return;
		}
		if (tabs.length === 0) return;

		if (key.leftArrow || key.rightArrow) {
			if (!pickerTabArrowsEnabled(showSearch, search)) return;
			return moveTab(key.leftArrow ? -1 : 1);
		}
		if (items.length === 0) return;

		if (key.pageUp) {
			setSelection((current) =>
				movePickerSelection(current, items.length, "pageUp"),
			);
		} else if (key.pageDown) {
			setSelection((current) =>
				movePickerSelection(current, items.length, "pageDown"),
			);
		} else if (key.upArrow) {
			setSelection((current) =>
				movePickerSelection(current, items.length, "up"),
			);
		} else if (key.downArrow) {
			setSelection((current) =>
				movePickerSelection(current, items.length, "down"),
			);
		} else if (!showSearch && key.return) {
			selectCurrentItem();
		}
	});

	if (error) {
		return (
			<Box marginTop={1} paddingX={2} flexDirection="column">
				<ErrorLine error={error} />
				<Text color={theme.subtle}>Esc return</Text>
			</Box>
		);
	}

	return (
		<Panel>
			<Box marginBottom={1} flexDirection="column">
				<Text color={theme.text} bold>
					{title}
				</Text>
				{subtitle ? <Text color={theme.subtle}>{subtitle}</Text> : null}
			</Box>

			{hasTabs ? (
				<PickerTabs
					tabs={tabs}
					activeIndex={safeTabIndex}
					accent={uiTheme.accentBright}
				/>
			) : null}

			{showSearch ? (
				<PickerSearch
					value={search}
					accent={uiTheme.accentBright}
					marginTop={hasTabs ? 1 : 0}
					onChange={updateSearch}
					onSubmit={selectCurrentItem}
				/>
			) : null}

			{activeTab?.error ? (
				<ErrorLine error={activeTab.error} />
			) : items.length === 0 ? (
				<Text color={theme.subtle}>
					{showSearch && search
						? "No items match this search."
						: (activeTab?.emptyLabel ?? emptyLabel)}
				</Text>
			) : (
				<>
					{hasPages ? (
						<Text color={theme.subtle}>
							{" "}
							{start + 1}-{end} of {items.length}
						</Text>
					) : null}
					{start > 0 ? <Text color={theme.subtle}> ↑ more</Text> : null}
					{visible.map((item, index) => (
						<PickerRow
							key={item.id}
							item={item}
							selected={start + index === safeItemIndex}
							layout={layout}
						/>
					))}
					{end < items.length ? (
						<Text color={theme.subtle}> ↓ more</Text>
					) : null}
				</>
			)}

			<Box marginTop={1}>
				<Text color={theme.subtle}>
					{footerText(showSearch, hasTabs, hasPages)}
				</Text>
			</Box>
			{selecting && selectingLabel ? <Spinner label={selectingLabel} /> : null}
		</Panel>
	);
}

function PickerTabs<T>({
	tabs,
	activeIndex,
	accent,
}: {
	tabs: readonly PickerTab<T>[];
	activeIndex: number;
	accent: string;
}): React.ReactElement {
	return (
		<Box flexWrap="wrap">
			{tabs.map((tab, index) => {
				const active = index === activeIndex;
				return (
					<Box key={tab.id}>
						<Text color={active ? accent : theme.subtle} bold={active}>
							{tab.label}
						</Text>
						{index < tabs.length - 1 ? (
							<Text color={theme.subtle}>{"  ·  "}</Text>
						) : null}
					</Box>
				);
			})}
			<Text color={theme.subtle}>{"     ←/→ switch"}</Text>
		</Box>
	);
}

function PickerSearch({
	value,
	accent,
	marginTop,
	onChange,
	onSubmit,
}: {
	value: string;
	accent: string;
	marginTop: number;
	onChange: (value: string) => void;
	onSubmit: () => void;
}): React.ReactElement {
	return (
		<Box marginTop={marginTop} marginBottom={1}>
			<Text color={accent}>Search: </Text>
			<TextInput
				// Remount after clears so the cursor lands back at the end.
				key={value.length === 0 ? "search-empty" : "search-active"}
				value={value}
				onChange={onChange}
				onSubmit={onSubmit}
				placeholder=""
				showCursor
				focus
			/>
		</Box>
	);
}

function PickerRow<T>({
	item,
	selected,
	layout,
}: {
	item: PickerItem<T>;
	selected: boolean;
	layout: ColumnLayout;
}): React.ReactElement {
	const disabled = Boolean(item.disabledReason);
	const nameColor = disabled
		? theme.subtle
		: selected
			? theme.accentBright
			: (item.nameColor ?? theme.subtle);
	const descColor = selected && !disabled ? theme.text : theme.subtle;
	const badgeColor = disabled
		? theme.subtle
		: (item.badgeColor ?? theme.subtle);
	return (
		<Box marginTop={item.spacingBefore ? 1 : 0}>
			<SelectCaret selected={selected} />
			<Text color={nameColor} bold={selected && !disabled}>
				{padColumn(item.name, layout.nameWidth)}
			</Text>
			{layout.statusWidth > 0 ? (
				<Text color={item.statusColor ?? theme.subtle}>
					{padColumn(item.status ?? "", layout.statusWidth)}
				</Text>
			) : null}
			<Text color={descColor}>
				{padColumn(item.description ?? "", layout.descWidth)}
			</Text>
			{item.badge ? (
				<Text color={badgeColor}>
					{`${" ".repeat(layout.badgeOffset)}${item.badge.padStart(layout.badgeWidth)}`}
				</Text>
			) : null}
		</Box>
	);
}

function computeColumnLayout<T>(
	items: readonly PickerItem<T>[],
	visible: readonly PickerItem<T>[],
	width: number,
): ColumnLayout {
	const nameWidth = longestLength(items, (item) => item.name) + COLUMN_GAP;
	const statusMax = longestLength(items, (item) => item.status ?? "");
	const statusWidth = statusMax > 0 ? statusMax + COLUMN_GAP : 0;
	const maxDesc = longestLength(visible, (item) => item.description ?? "");
	const badgeWidth = longestLength(visible, (item) => item.badge ?? "");
	const fixedWidth =
		HORIZONTAL_PADDING_WIDTH + ROW_PREFIX_WIDTH + nameWidth + statusWidth;
	const descBudget = width - fixedWidth - badgeWidth - COLUMN_GAP;
	const descWidth = Math.max(
		MIN_DESC_WIDTH,
		Math.min(maxDesc + COLUMN_GAP, descBudget),
	);
	const badgeOffset = Math.max(0, width - fixedWidth - descWidth - badgeWidth);
	return { nameWidth, statusWidth, descWidth, badgeWidth, badgeOffset };
}

function longestLength<T>(
	items: readonly PickerItem<T>[],
	pick: (item: PickerItem<T>) => string,
): number {
	return items.reduce((max, item) => Math.max(max, pick(item).length), 0);
}

function footerText(
	showSearch: boolean,
	hasTabs: boolean,
	hasPages: boolean,
): string {
	return hintFooterText([
		showSearch && "type to search",
		hasTabs && "←/→ tabs",
		"↑/↓ choose",
		hasPages && "PgUp/PgDn page",
		"Enter select",
		"Esc cancel",
	]);
}

export function filterItems<T>(
	items: readonly PickerItem<T>[],
	query: string,
): PickerItem<T>[] {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return [...items];
	return items.filter(
		(item) =>
			(item.status ?? "").toLowerCase() === normalized ||
			[
				item.name,
				item.badge ?? "",
				item.description ?? "",
				item.id,
				item.detail ?? "",
			]
				.join(" ")
				.toLowerCase()
				.includes(normalized),
	);
}

/** While the user is editing search text, ←/→ move the text cursor instead of switching tabs. */
export function pickerTabArrowsEnabled(
	showSearch: boolean,
	search: string,
): boolean {
	return !showSearch || search.length === 0;
}

export function resetPickerSelection(itemIndex = 0): PickerSelection {
	return { itemIndex, windowStart: 0 };
}

export function initialPickerPosition<T>(
	tabs: readonly PickerTab<T>[],
	itemId: string | undefined,
): { tabIndex: number; itemIndex: number } {
	if (itemId) {
		for (const [tabIndex, tab] of tabs.entries()) {
			const itemIndex = tab.items.findIndex((item) => item.id === itemId);
			if (itemIndex >= 0) return { tabIndex, itemIndex };
		}
	}
	return { tabIndex: 0, itemIndex: 0 };
}

export function movePickerSelection(
	selection: PickerSelection,
	itemCount: number,
	move: PickerMove,
	visibleItems = VISIBLE_ITEMS,
): PickerSelection {
	if (itemCount <= 0) return resetPickerSelection();
	const current = normalizePickerSelection(selection, itemCount, visibleItems);
	const lastIndex = itemCount - 1;
	const maxStart = Math.max(0, itemCount - visibleItems);

	switch (move) {
		case "pageUp":
			return normalizePickerSelection(
				{
					itemIndex: Math.max(0, current.itemIndex - visibleItems),
					windowStart: Math.max(0, current.windowStart - visibleItems),
				},
				itemCount,
				visibleItems,
			);
		case "pageDown":
			return normalizePickerSelection(
				{
					itemIndex: Math.min(lastIndex, current.itemIndex + visibleItems),
					windowStart: Math.min(maxStart, current.windowStart + visibleItems),
				},
				itemCount,
				visibleItems,
			);
		case "up":
			return normalizePickerSelection(
				{
					itemIndex: current.itemIndex <= 0 ? lastIndex : current.itemIndex - 1,
					windowStart: current.windowStart,
				},
				itemCount,
				visibleItems,
			);
		case "down":
			return normalizePickerSelection(
				{
					itemIndex: current.itemIndex >= lastIndex ? 0 : current.itemIndex + 1,
					windowStart: current.windowStart,
				},
				itemCount,
				visibleItems,
			);
	}
}

export function normalizePickerSelection(
	selection: PickerSelection,
	itemCount: number,
	visibleItems = VISIBLE_ITEMS,
): PickerSelection {
	if (itemCount <= 0) return resetPickerSelection();
	const itemIndex = Math.min(Math.max(selection.itemIndex, 0), itemCount - 1);
	const maxStart = Math.max(0, itemCount - visibleItems);
	let windowStart = Math.min(Math.max(selection.windowStart, 0), maxStart);
	if (itemIndex < windowStart) windowStart = itemIndex;
	if (itemIndex >= windowStart + visibleItems) {
		windowStart = Math.min(maxStart, itemIndex - visibleItems + 1);
	}
	return { itemIndex, windowStart };
}
