import { Box, Text, useApp, useInput, useStdout, useWindowSize } from "ink";
import type React from "react";
import { useMemo, useState } from "react";
import { errorMessage } from "../utils/errors.ts";
import type {
	AuthAction,
	AuthScreenMode,
	AuthScreenProps,
} from "./AuthScreenTypes.ts";
import { AuthPrompt } from "./components/AuthPrompt.tsx";
import { ProviderKeySetup } from "./components/ProviderKeySetup.tsx";
import { Spinner } from "./components/Spinner.tsx";
import { useResizeStabilizer } from "./hooks/useResizeStabilizer.ts";
import { theme } from "./theme/theme.ts";
import { renderQrCodeLines } from "./utils/qrCode.ts";

const AUTH_ACTIONS_WITH_BYOK: readonly AuthAction[] = ["login", "byok", "exit"];
const AUTH_ACTIONS_LOGIN_ONLY: readonly AuthAction[] = ["login", "exit"];

// Rows the loading screen needs besides the QR itself:
// full: prompt 14 + spinner 2 + url/code text 5 + QR label/margins 3
// compact: spinner 1 + url/code text 4 + QR label/margins 3
const FULL_RESERVED_ROWS = 24;
const COMPACT_RESERVED_ROWS = 8;
const QR_SIDE_PADDING = 2;

export type AuthLoadingLayout = {
	showPrompt: boolean;
	showQr: boolean;
};

// Prefer the full screen; drop the prompt banner to fit the QR, or hide the QR
// entirely if even compact does not fit; never let the QR wrap or overflow.
export function authLoadingLayout(
	qrLines: string[],
	columns: number,
	rows: number,
): AuthLoadingLayout {
	const width = qrLines[0]?.length ?? 0;
	if (width === 0 || columns < width + QR_SIDE_PADDING) {
		return { showPrompt: true, showQr: false };
	}
	if (rows >= qrLines.length + FULL_RESERVED_ROWS) {
		return { showPrompt: true, showQr: true };
	}
	if (rows >= qrLines.length + COMPACT_RESERVED_ROWS) {
		return { showPrompt: false, showQr: true };
	}
	return { showPrompt: true, showQr: false };
}

export function AuthScreen({
	onLogin,
	keys,
	onKeySaved,
}: AuthScreenProps): React.ReactElement {
	const app = useApp();
	const actions = keys ? AUTH_ACTIONS_WITH_BYOK : AUTH_ACTIONS_LOGIN_ONLY;
	const [mode, setMode] = useState<AuthScreenMode>("select");
	const [selected, setSelected] = useState<AuthAction>("login");
	const [deviceCode, setDeviceCode] = useState<{
		userCode: string;
		verificationUri: string;
		verificationUriComplete: string;
	} | null>(null);
	const [error, setError] = useState<string | null>(null);
	const { columns, rows } = useWindowSize();
	const { stdout, write } = useStdout();
	const resize = useResizeStabilizer(
		{ columns, rows },
		{ isTerminal: stdout.isTTY, write },
	);
	const qrLines = useMemo(
		() =>
			deviceCode ? renderQrCodeLines(deviceCode.verificationUriComplete) : [],
		[deviceCode],
	);
	const layout = authLoadingLayout(qrLines, columns, rows);

	const submitSelected = (): void => {
		if (mode === "loading") {
			return;
		}
		if (selected === "exit") {
			app.exit();
			return;
		}
		if (selected === "byok") {
			setError(null);
			setMode("byok");
			return;
		}

		setError(null);
		setDeviceCode(null);
		setMode("loading");
		void onLogin((response) => {
			setDeviceCode({
				userCode: response.user_code,
				verificationUri: response.verification_uri,
				verificationUriComplete: response.verification_uri_complete,
			});
		})
			.then(() => app.exit())
			.catch((err) => {
				setError(errorMessage(err));
				setMode("select");
			});
	};

	useInput(
		(_input, key) => {
			if (key.escape) {
				app.exit();
				return;
			}
			if (key.upArrow || key.downArrow) {
				setSelected((current) =>
					nextAction(current, actions, key.upArrow ? -1 : 1),
				);
				return;
			}
			if (key.return) {
				submitSelected();
			}
		},
		// The BYOK step owns the keyboard while it is open; leaving this handler
		// active would make Esc close the whole screen instead of stepping back.
		{ isActive: mode === "select" },
	);

	if (resize.isResizing) {
		return <Box />;
	}

	if (mode === "byok" && keys) {
		return (
			<Box flexDirection="column">
				<AuthPrompt selected={selected} columns={columns} />
				<ProviderKeySetup
					controller={keys}
					onDone={() => {
						onKeySaved?.();
						app.exit();
					}}
					onCancel={() => setMode("select")}
				/>
			</Box>
		);
	}

	if (mode === "loading") {
		return (
			<Box flexDirection="column">
				{layout.showPrompt ? (
					<AuthPrompt selected={selected} columns={columns} />
				) : null}
				<Box marginTop={layout.showPrompt ? 1 : 0} paddingX={1}>
					<Spinner label="Waiting for approval" />
				</Box>
				{deviceCode ? (
					<Box marginTop={1} flexDirection="column" paddingX={1}>
						<Text color={theme.subtle}>
							Open this URL on any device with a browser (code already filled
							in):
						</Text>
						<Text>{deviceCode.verificationUriComplete}</Text>
						{layout.showPrompt ? (
							<>
								<Text color={theme.subtle}>
									Or go to {deviceCode.verificationUri} and enter code:
								</Text>
								<Text bold>{deviceCode.userCode}</Text>
							</>
						) : (
							<Text color={theme.subtle}>
								Or go to {deviceCode.verificationUri} and enter code:{" "}
								<Text bold color={theme.text}>
									{deviceCode.userCode}
								</Text>
							</Text>
						)}
						{layout.showQr ? (
							<Box marginTop={1} flexDirection="column">
								<Text color={theme.subtle}>
									Or scan this QR code with your phone:
								</Text>
								<Box marginTop={1}>
									<Text>{qrLines.join("\n")}</Text>
								</Box>
							</Box>
						) : null}
					</Box>
				) : null}
			</Box>
		);
	}

	return (
		<Box flexDirection="column">
			<AuthPrompt selected={selected} columns={columns} />
			{error ? <Text color={theme.error}>{error}</Text> : null}
		</Box>
	);
}

function nextAction(
	current: AuthAction,
	actions: readonly AuthAction[],
	delta: number,
): AuthAction {
	const index = actions.indexOf(current);
	const next = (index + delta + actions.length) % actions.length;
	return actions[next] ?? "login";
}
