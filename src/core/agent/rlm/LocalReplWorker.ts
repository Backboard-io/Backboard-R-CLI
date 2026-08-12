import { MAX_RLM_REPL_OUTPUT_CHARS } from "./RLMConstants.ts";

export const LOCAL_REPL_WORKER_SOURCE = String.raw`
const { createContext, runInContext } = require("node:vm");
const { parentPort } = require("node:worker_threads");

if (!parentPort) throw new Error("LocalReplWorker requires parentPort");

const MAX_RLM_REPL_OUTPUT_CHARS = ${MAX_RLM_REPL_OUTPUT_CHARS};
const RESERVED_SANDBOX_NAMES = new Set([
	"context",
	"inputs",
	"state",
	"print",
	"inspect",
	"console",
	"SUBMIT",
	"llm",
	"llm_batch",
	"llm_query",
	"llm_query_batched",
]);

let context = null;
let buffer = [];
let submitted = null;
let didSubmit = false;
let nextLlmRequestId = 1;
const pending = new Map();

parentPort.on("message", async (message) => {
	try {
		switch (message.type) {
			case "init":
				init(message.context, message.variables);
				post({ type: "ready", id: message.id });
				break;
			case "execute":
				post({
					type: "executeResult",
					id: message.id,
					result: await execute(message.code, message.timeoutMs),
				});
				break;
			case "llmResponse": {
				const entry = pending.get(message.requestId);
				if (entry) {
					pending.delete(message.requestId);
					entry.resolve(message.value);
				}
				break;
			}
			case "llmError": {
				const entry = pending.get(message.requestId);
				if (entry) {
					pending.delete(message.requestId);
					entry.reject(new Error(message.error));
				}
				break;
			}
			case "dispose":
				context = null;
				buffer = [];
				pending.clear();
				post({ type: "disposed", id: message.id });
				break;
		}
	} catch (err) {
		post({
			type: "error",
			id: "id" in message ? message.id : 0,
			error: errorMessage(err),
		});
	}
});

function init(prompt, variables = {}) {
	const write = (...args) => {
		buffer.push(args.map(String).join(" "));
	};
	const submit = (output) => {
		if (!didSubmit) {
			submitted = output ?? null;
			didSubmit = true;
		}
		throw new SubmitSignal();
	};
	const variableBindings = Object.create(null);
	variableBindings.inputs = variables;
	for (const [name, value] of Object.entries(variables)) {
		if (isBindableVariableName(name)) variableBindings[name] = value;
	}
	const inspect = (value) => {
		if (typeof value === "string") return value;
		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return String(value);
		}
	};
	const sandbox = Object.create(null);
	Object.assign(sandbox, variableBindings, {
		context: prompt,
		state: Object.create(null),
		print: write,
		inspect,
		console: { log: write, error: write, warn: write, info: write },
		SUBMIT: submit,
		llm: (prompt) => requestLLM({ kind: "single", prompt }),
		llm_batch: (prompts) => requestLLM({ kind: "batch", prompts }),
		llm_query: (prompt) => requestLLM({ kind: "single", prompt }),
		llm_query_batched: (prompts) => requestLLM({ kind: "batch", prompts }),
	});
	context = createContext(sandbox, {
		codeGeneration: { strings: false, wasm: false },
	});
}

async function execute(code, timeoutMs) {
	if (!context) throw new Error("LocalReplWorker.execute called before init");
	buffer = [];
	submitted = null;
	didSubmit = false;

	try {
		const result = runInContext(
			"(async () => {\n" + code + "\n})()",
			context,
			timeoutMs === undefined ? undefined : { timeout: timeoutMs },
		);
		await result;
		return observation(true);
	} catch (err) {
		if (err instanceof SubmitSignal || didSubmit) {
			return observation(true);
		}
		return observation(false, errorMessage(err));
	}
}

function observation(ok, stderr = "") {
	const stdout = buffer.join("\n");
	return {
		ok,
		stdout:
			stdout.length > MAX_RLM_REPL_OUTPUT_CHARS
				? stdout.slice(0, MAX_RLM_REPL_OUTPUT_CHARS) + "\n[truncated]"
				: stdout,
		stderr,
		...(didSubmit ? { submitted } : {}),
	};
}

function requestLLM(input) {
	const requestId = nextLlmRequestId++;
	if (input.kind === "single") {
		post({
			type: "llmRequest",
			requestId,
			kind: input.kind,
			prompt: input.prompt,
		});
	} else {
		post({
			type: "llmRequest",
			requestId,
			kind: input.kind,
			prompts: input.prompts,
		});
	}
	return new Promise((resolve, reject) => {
		pending.set(requestId, { resolve, reject });
	});
}

function post(message) {
	parentPort.postMessage(message);
}

function isBindableVariableName(name) {
	return /^[A-Za-z_$][\w$]*$/.test(name) && !RESERVED_SANDBOX_NAMES.has(name);
}

function errorMessage(err) {
	return err instanceof Error ? err.message : String(err);
}

class SubmitSignal extends Error {
	constructor() {
		super("submitted");
		this.name = "SubmitSignal";
	}
}
`;
