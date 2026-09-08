import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type React from "react";
import { useState } from "react";
import { normalizeApiUrl } from "../../config/env.ts";
import {
	CUSTOM_PROVIDER_PROTOCOLS,
	type CustomModelDefinition,
	type CustomProviderAuth,
	type CustomProviderDefinition,
	type CustomProviderProtocol,
	isCredentialHeader,
	isValidProviderId,
	normalizeProviderId,
} from "../../config/providers.ts";
import type { ProviderKeyController } from "../../core/keys/ProviderKeyController.ts";
import { errorMessage } from "../../utils/errors.ts";
import type { JsonObject } from "../../utils/JsonTypes.ts";
import { useAsyncAction } from "../hooks/useAsyncAction.ts";
import { theme } from "../theme/theme.ts";
import { EntryListEditor } from "./EntryListEditor.tsx";
import type { EntryListItem } from "./EntryListEditor.types.ts";
import { ErrorLine } from "./ErrorLine.tsx";
import { HintFooter } from "./HintFooter.tsx";
import { Panel } from "./Panel.tsx";
import { SelectRow } from "./SelectRow.tsx";
import { Spinner } from "./Spinner.tsx";

interface Props {
	controller: ProviderKeyController;
	existing?: CustomProviderDefinition;
	onDone: (provider: string) => void;
	onCancel: () => void;
}

const AUTH_OPTIONS: readonly CustomProviderAuth["type"][] = [
	"apiKey",
	"env",
	"none",
];

type Draft = {
	name: string;
	id: string;
	protocol: CustomProviderProtocol;
	baseUrl: string;
	authType: CustomProviderAuth["type"];
	credential: string;
	modelsEndpoint: string;
	models: CustomModelDefinition[];
	headers: Record<string, string>;
	extraArgs: JsonObject;
};

const FIELD_LABELS = [
	"Provider name",
	"Provider id",
	"Protocol",
	"Base URL",
	"Authentication",
	"Credential",
	"Models endpoint",
	"Manual models",
	"Headers",
	"Extra request arguments",
] as const;

export function CustomProviderSetup({
	controller,
	existing,
	onDone,
	onCancel,
}: Props): React.ReactElement {
	const [draft, setDraft] = useState<Draft>(() => ({
		name: existing?.name ?? "",
		id: existing?.id ?? "",
		protocol: existing?.protocol ?? "openai-chat",
		baseUrl: existing?.baseUrl ?? "",
		authType: existing ? (existing.auth?.type ?? "apiKey") : "none",
		credential: existing?.auth?.type === "env" ? existing.auth.variable : "",
		modelsEndpoint:
			existing?.discoverModels === false
				? "off"
				: (existing?.modelsPath ?? "models"),
		models: existing?.models ?? [],
		headers: existing?.headers ?? {},
		extraArgs: existing?.extraArgs ?? {},
	}));
	const [step, setStep] = useState(0);
	const [choiceIndex, setChoiceIndex] = useState(0);
	const asyncAction = useAsyncAction();
	const { error, running: saving, setError } = asyncAction;
	const editing = existing !== undefined;

	const isProtocol = step === 2;
	const isAuth = step === 4;
	const isEntryList = step >= 7 && step <= 9;
	const isReview = step >= FIELD_LABELS.length;

	const advance = (): void => {
		setError(null);
		let next = step + 1;
		if (step === 4 && draft.authType === "none") next = 6;
		setStep(next);
		setChoiceIndex(choiceForStep(next, draft));
	};

	const back = (): void => {
		if (step === 0) {
			onCancel();
			return;
		}
		let next = step - 1;
		if (step === 6 && draft.authType === "none") next = 4;
		setStep(next);
		setError(null);
		setChoiceIndex(choiceForStep(next, draft));
	};

	const save = (): void => {
		if (saving) return;
		let definition: CustomProviderDefinition;
		try {
			definition = buildDefinition(draft);
		} catch (err) {
			setError(errorMessage(err));
			return;
		}
		asyncAction.run(`Testing ${draft.name}`, async (signal) => {
			await controller.saveCustomProvider(
				definition,
				draft.authType === "apiKey" && draft.credential.trim()
					? draft.credential
					: undefined,
				existing?.id,
				signal,
			);
			onDone(definition.id);
		});
	};

	useInput((input, key) => {
		if (isEntryList) return;
		if (saving) {
			if (key.escape) asyncAction.cancel();
			return;
		}
		if (key.escape) {
			back();
			return;
		}
		if (isReview) {
			if (key.return) save();
			return;
		}
		if (!isProtocol && !isAuth) return;
		const options = isProtocol ? CUSTOM_PROVIDER_PROTOCOLS : AUTH_OPTIONS;
		if (key.upArrow || input === "k") {
			setChoiceIndex((index) => (index - 1 + options.length) % options.length);
			return;
		}
		if (key.downArrow || input === "j") {
			setChoiceIndex((index) => (index + 1) % options.length);
			return;
		}
		if (key.return) {
			if (isProtocol) {
				setDraft((current) => ({
					...current,
					protocol: CUSTOM_PROVIDER_PROTOCOLS[choiceIndex] ?? "openai-chat",
				}));
				setStep(3);
				setChoiceIndex(0);
				setError(null);
			} else {
				const authType = AUTH_OPTIONS[choiceIndex] ?? "apiKey";
				setDraft((current) => ({
					...current,
					authType,
					credential: authType === current.authType ? current.credential : "",
				}));
				setStep(authType === "none" ? 6 : 5);
				setChoiceIndex(0);
				setError(null);
			}
		}
	});

	if (isProtocol || isAuth) {
		const options = isProtocol ? CUSTOM_PROVIDER_PROTOCOLS : AUTH_OPTIONS;
		return (
			<Panel title={FIELD_LABELS[step]}>
				<Box flexDirection="column">
					{options.map((option, index) => (
						<SelectRow key={option} selected={choiceIndex === index}>
							<Text
								color={choiceIndex === index ? theme.accentBright : theme.text}
								bold={choiceIndex === index}
							>
								{optionLabel(option)}
							</Text>
						</SelectRow>
					))}
				</Box>
				<HintFooter hints={["↑/↓ move", "Enter select", "Esc back"]} />
			</Panel>
		);
	}

	if (isReview) {
		return (
			<Panel title={editing ? "Update provider" : "Add provider"}>
				<Box flexDirection="column">
					<Text color={theme.text}>
						{draft.name} ({normalizeProviderId(draft.id)})
					</Text>
					<Text color={theme.subtle}>
						{draft.protocol} · {draft.baseUrl}
					</Text>
					<Text color={theme.subtle}>
						Auth: {optionLabel(draft.authType)} · Models:{" "}
						{draft.modelsEndpoint.trim().toLowerCase() === "off"
							? "manual only"
							: `discover via ${draft.modelsEndpoint}`}
					</Text>
				</Box>
				<ErrorLine error={error} />
				{saving && asyncAction.label ? (
					<Spinner label={asyncAction.label} />
				) : null}
				<HintFooter
					hints={saving ? ["Esc cancel"] : ["Enter test & save", "Esc back"]}
				/>
			</Panel>
		);
	}

	if (step === 7) {
		return (
			<Panel title={FIELD_LABELS[step]}>
				<EntryListEditor
					key="provider-models"
					title="Models"
					help="Add model IDs that are not returned by model discovery."
					entries={draft.models.map((model) => ({
						key: model.id,
						value: "",
						data: model,
					}))}
					keyLabel="Model ID"
					keyPlaceholder="gpt-5"
					onChange={(entries) => {
						setDraft((current) => ({
							...current,
							models: entries.map((entry) => ({
								...(isCustomModelDefinition(entry.data) ? entry.data : {}),
								id: entry.key,
							})),
						}));
						setError(null);
					}}
					onSubmit={advance}
					onCancel={back}
				/>
			</Panel>
		);
	}

	if (step === 8 || step === 9) {
		const headers = step === 8;
		const entries = objectEntries(headers ? draft.headers : draft.extraArgs);
		return (
			<Panel title={FIELD_LABELS[step]}>
				<EntryListEditor
					key={headers ? "provider-headers" : "provider-arguments"}
					title={headers ? "Headers" : "Request arguments"}
					help={
						headers
							? "Values may reference environment variables. Secret headers are masked."
							: "Numbers, booleans, null, arrays, and objects are detected automatically."
					}
					entries={entries}
					keyLabel={headers ? "Header" : "Argument"}
					valueLabel="Value"
					keyPlaceholder={headers ? "X-Custom-Header" : "temperature"}
					valuePlaceholder={headers ? "value" : "0.2"}
					isSecret={isSensitiveKey}
					validate={(entry) => validateEntry(entry, headers)}
					onChange={(next) => {
						setDraft((current) => ({
							...current,
							...(headers
								? { headers: entriesToHeaders(next) }
								: { extraArgs: entriesToObject(next) }),
						}));
						setError(null);
					}}
					onSubmit={advance}
					onCancel={back}
				/>
			</Panel>
		);
	}

	const value = valueForStep(draft, step);
	const secret = step === 5 && draft.authType === "apiKey";
	return (
		<Panel title={FIELD_LABELS[step]}>
			<Text color={theme.subtle}>{helpForStep(step, draft.authType)}</Text>
			<Box marginTop={1}>
				<TextInput
					value={value}
					onChange={(next) => {
						setDraft((current) => setValueForStep(current, step, next));
						setError(null);
					}}
					onSubmit={() => {
						try {
							validateStep(draft, step);
							if (step === 0 && !draft.id) {
								setDraft((current) => ({
									...current,
									id: slug(current.name),
								}));
							}
							advance();
						} catch (err) {
							setError(errorMessage(err));
						}
					}}
					placeholder={placeholderForStep(step, draft.authType, editing)}
					{...(secret ? { mask: "•" } : {})}
				/>
			</Box>
			<ErrorLine error={error} />
			<HintFooter hints={["Enter next", "Esc back"]} />
		</Panel>
	);
}

function buildDefinition(draft: Draft): CustomProviderDefinition {
	for (const step of [0, 1, 3, 5, 6, 7, 8, 9]) {
		if (step === 5 && draft.authType === "none") continue;
		validateStep(draft, step);
	}
	const endpoint = draft.modelsEndpoint.trim();
	const definition: CustomProviderDefinition = {
		id: normalizeProviderId(draft.id),
		name: draft.name.trim(),
		protocol: draft.protocol,
		baseUrl: normalizeApiUrl(draft.baseUrl),
		auth:
			draft.authType === "env"
				? { type: "env", variable: draft.credential.trim() }
				: { type: draft.authType },
		discoverModels: endpoint.toLowerCase() !== "off",
		headers: draft.headers,
		extraArgs: draft.extraArgs,
		models: draft.models,
	};
	if (definition.discoverModels && endpoint && endpoint !== "models") {
		definition.modelsPath = endpoint;
	}
	return definition;
}

function validateStep(draft: Draft, step: number): void {
	if (step === 0 && !draft.name.trim())
		throw new Error("Enter a provider name.");
	if (step === 1 && !isValidProviderId(draft.id)) {
		throw new Error(
			"Provider id must use lowercase letters, numbers, dots, dashes, or underscores.",
		);
	}
	if (step === 3) {
		try {
			const url = new URL(
				draft.baseUrl
					.trim()
					.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, "placeholder"),
			);
			if (url.protocol !== "http:" && url.protocol !== "https:") throw null;
		} catch {
			throw new Error("Enter an HTTP or HTTPS base URL.");
		}
	}
	if (step === 5) {
		if (draft.authType === "env") {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(draft.credential.trim())) {
				throw new Error("Enter an environment variable name.");
			}
		}
	}
	if (step === 6 && !draft.modelsEndpoint.trim()) {
		throw new Error('Enter a models endpoint, or "off".');
	}
}

function parseEntryValue(value: string): JsonObject[string] {
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function objectEntries(value: JsonObject): EntryListItem[] {
	return Object.entries(value).map(([key, entry]) => ({
		key,
		value: displayEntryValue(entry),
		data: entry,
	}));
}

function entriesToObject(entries: readonly EntryListItem[]): JsonObject {
	return Object.fromEntries(
		entries.map((entry) => [
			entry.key,
			entry.data !== undefined &&
			displayEntryValue(entry.data as JsonObject[string]) === entry.value
				? (entry.data as JsonObject[string])
				: parseEntryValue(entry.value),
		]),
	);
}

function displayEntryValue(value: JsonObject[string]): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

function isCustomModelDefinition(
	value: unknown,
): value is CustomModelDefinition {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		typeof (value as { id?: unknown }).id === "string"
	);
}

function entriesToHeaders(
	entries: readonly EntryListItem[],
): Record<string, string> {
	return Object.fromEntries(entries.map((entry) => [entry.key, entry.value]));
}

function isSensitiveKey(key: string): boolean {
	return (
		isCredentialHeader(key) ||
		/(?:auth|cookie|token|secret|api[-_]?key|credential|password)/i.test(key)
	);
}

function validateEntry(entry: EntryListItem, header: boolean): void {
	if (header && !entry.value.trim()) {
		throw new Error("Header values cannot be empty.");
	}
	if (
		isSensitiveKey(entry.key) &&
		!/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(entry.value)
	) {
		throw new Error(
			`${entry.key} may contain a secret; use an environment variable reference.`,
		);
	}
}

function slug(value: string): string {
	return normalizeProviderId(value)
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[^a-z0-9]+/, "")
		.slice(0, 64);
}

function valueForStep(draft: Draft, step: number): string {
	switch (step) {
		case 0:
			return draft.name;
		case 1:
			return draft.id;
		case 3:
			return draft.baseUrl;
		case 5:
			return draft.credential;
		case 6:
			return draft.modelsEndpoint;
		default:
			return "";
	}
}

function setValueForStep(draft: Draft, step: number, value: string): Draft {
	switch (step) {
		case 0:
			return { ...draft, name: value };
		case 1:
			return { ...draft, id: value };
		case 3:
			return { ...draft, baseUrl: value };
		case 5:
			return { ...draft, credential: value };
		case 6:
			return { ...draft, modelsEndpoint: value };
		default:
			return draft;
	}
}

function optionLabel(value: string): string {
	switch (value) {
		case "apiKey":
			return "Encrypted API key";
		case "env":
			return "Environment variable";
		case "none":
			return "No authentication";
		case "openai-chat":
			return "OpenAI Chat Completions";
		case "openai-responses":
			return "OpenAI Responses";
		case "anthropic-messages":
			return "Anthropic Messages";
		default:
			return value;
	}
}

function choiceForStep(step: number, draft: Draft): number {
	if (step === 2) {
		return Math.max(0, CUSTOM_PROVIDER_PROTOCOLS.indexOf(draft.protocol));
	}
	if (step === 4) {
		return Math.max(0, AUTH_OPTIONS.indexOf(draft.authType));
	}
	return 0;
}

function helpForStep(step: number, auth: CustomProviderAuth["type"]): string {
	switch (step) {
		case 1:
			return "Stable id used in provider/model references.";
		case 5:
			return auth === "env"
				? "The variable is resolved each time the CLI starts."
				: "Stored encrypted and never rendered in terminal output.";
		case 6:
			return 'Usually "models". Use a path or full URL, or "off" for manual models only.';
		default:
			return "";
	}
}

function placeholderForStep(
	step: number,
	auth: CustomProviderAuth["type"],
	editing: boolean,
): string {
	switch (step) {
		case 0:
			return "My provider";
		case 1:
			return "my-provider";
		case 3:
			return "https://api.example.com";
		case 5:
			return auth === "env"
				? "PROVIDER_API_KEY"
				: editing
					? "Leave blank to keep saved key"
					: "API key";
		case 6:
			return "models";
		default:
			return "";
	}
}
