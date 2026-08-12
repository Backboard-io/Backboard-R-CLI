import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type React from "react";
import { useState } from "react";
import { useAsyncAction } from "../hooks/useAsyncAction.ts";
import { theme } from "../theme/theme.ts";
import { ErrorLine } from "./ErrorLine.tsx";
import { HintFooter } from "./HintFooter.tsx";
import { Panel } from "./Panel.tsx";
import { Spinner } from "./Spinner.tsx";

interface Props {
	onSubmit: (input: string, signal?: AbortSignal) => Promise<void> | void;
	onCancel: () => void;
}

export function ManualMcpInput({
	onSubmit,
	onCancel,
}: Props): React.ReactElement {
	const [value, setValue] = useState("");
	const asyncAction = useAsyncAction();

	useInput((_input, key) => {
		if (asyncAction.running) {
			if (key.escape) asyncAction.cancel();
			return;
		}
		if (key.escape) onCancel();
	});

	const submit = (): void => {
		if (asyncAction.running) return;
		const trimmed = value.trim();
		if (!trimmed) {
			asyncAction.setError("Enter an MCP server URL or command.");
			return;
		}
		asyncAction.run("Adding MCP server", async (signal) => {
			await onSubmit(trimmed, signal);
		});
	};

	return (
		<Panel title="Add MCP server manually">
			<Text color={theme.subtle}>
				Enter name=https://host/mcp or name=npx -y package
			</Text>
			<Box>
				<Text color={theme.subtle}>Server: </Text>
				<TextInput
					value={value}
					onChange={(next) => {
						setValue(next);
						asyncAction.setError(null);
					}}
					onSubmit={submit}
					placeholder="linear=https://mcp.example.com/mcp"
					focus
				/>
			</Box>
			<ErrorLine error={asyncAction.error} />
			<HintFooter marginTop={0} hints={["Enter add", "Esc cancel"]} />
			{asyncAction.running && asyncAction.label ? (
				<Spinner label={asyncAction.label} />
			) : null}
		</Panel>
	);
}
