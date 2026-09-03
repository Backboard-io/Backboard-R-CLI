import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type React from "react";
import { useState } from "react";
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
import { theme } from "../theme/theme.ts";
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
	models: string;
	headers: string;
	extraArgs: string;
};

const FIELD_LABELS = [
	"Provider name",
	"Provider id",
	"Protocol",
	"Base URL",
	"Authentication",
	"Credential",
	"Models endpoint",
	"Manual models JSON",
	"Headers JSON",
	"Extra request args JSON",
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
		models: JSON.stringify(existing?.models ?? []),
		headers: JSON.stringify(existing?.headers ?? {}),
		extraArgs: JSON.stringify(existing?.extraArgs ?? {}),
	}));
	const [step, setStep] = useState(0);
	const [choiceIndex, setChoiceIndex] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const editing = existing !== undefined;

	const isProtocol = step === 2;
	const isAuth = step === 4;
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
		setSaving(true);
		setError(null);
		controller
			.saveCustomProvider(
				definition,
				draft.authType === "apiKey" && draft.credential.trim()
					? draft.credential
					: undefined,
				existing?.id,
			)
			.then(() => onDone(definition.id))
			.catch((err) => setError(errorMessage(err)))
			.finally(() => setSaving(false));
	};

	useInput((input, key) => {
		if (saving) return;
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
					credential: "",
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
				{saving ? <Spinner label={`Testing ${draft.name}`} /> : null}
				<HintFooter hints={["Enter test & save", "Esc back"]} />
			</Panel>
		);
	}

	const value = valueForStep(draft, step);
	const secret =
		(step === 5 && draft.authType === "apiKey") ||
		(step === 8 && containsCredentialHeader(value));
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
		baseUrl: draft.baseUrl.trim().replace(/\/+$/, ""),
		auth:
			draft.authType === "env"
				? { type: "env", variable: draft.credential.trim() }
				: { type: draft.authType },
		discoverModels: endpoint.toLowerCase() !== "off",
		headers: parseHeaders(draft.headers),
		extraArgs: parseObject(draft.extraArgs, "Extra request arguments"),
		models: parseModels(draft.models),
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
	if (step === 7) parseModels(draft.models);
	if (step === 8) parseHeaders(draft.headers);
	if (step === 9) parseObject(draft.extraArgs, "Extra request arguments");
}

function parseModels(value: string): CustomModelDefinition[] {
	const parsed = parseJson(value || "[]", "Manual models");
	if (!Array.isArray(parsed))
		throw new Error("Manual models must be a JSON array.");
	for (const model of parsed) {
		if (
			typeof model !== "object" ||
			model === null ||
			Array.isArray(model) ||
			typeof (model as { id?: unknown }).id !== "string"
		) {
			throw new Error('Each manual model needs an "id" string.');
		}
	}
	return parsed as CustomModelDefinition[];
}

function parseObject(value: string, label: string): JsonObject {
	const parsed = parseJson(value || "{}", label);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${label} must be a JSON object.`);
	}
	return parsed as JsonObject;
}

function parseHeaders(value: string): Record<string, string> {
	const parsed = parseObject(value, "Headers");
	for (const [name, headerValue] of Object.entries(parsed)) {
		if (!name.trim() || typeof headerValue !== "string") {
			throw new Error("Header names and values must be strings.");
		}
		if (
			isCredentialHeader(name) &&
			!/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(headerValue)
		) {
			throw new Error(
				`Header ${name} may contain a secret; use an environment variable reference.`,
			);
		}
	}
	return parsed as Record<string, string>;
}

function containsCredentialHeader(value: string): boolean {
	return /"(?:[^"]*(?:auth|cookie|token|secret|api[-_]?key|credential|password)[^"]*)"\s*:/i.test(
		value,
	);
}

function parseJson(value: string, label: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		throw new Error(`${label} contains invalid JSON.`);
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
		case 7:
			return draft.models;
		case 8:
			return draft.headers;
		case 9:
			return draft.extraArgs;
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
		case 7:
			return { ...draft, models: value };
		case 8:
			return { ...draft, headers: value };
		case 9:
			return { ...draft, extraArgs: value };
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
		case 7:
			return 'Example: [{"id":"gpt-5","contextLimit":400000,"maxOutputTokens":32768}]';
		case 8:
			return (
				'Values may reference environment variables, e.g. {"X-Key":"' +
				"$" +
				"{TOKEN}" +
				'"}'
			);
		case 9:
			return '{"temperature":0.2}. Transport fields are protected.';
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
		case 7:
			return "[]";
		case 8:
		case 9:
			return "{}";
		default:
			return "";
	}
}
