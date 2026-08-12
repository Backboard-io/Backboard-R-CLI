import {
	RLM_MISSING_CODE_MESSAGE,
	rlmActionPrompt,
	rlmExecutionResultMessage,
	rlmExtractPrompt,
	rlmNativeToolCallMessage,
	rlmSubmittedReport,
	rlmTimedOutSummaryPrompt,
} from "../../../prompts/agent/rlm.tsx";
import type {
	BackboardResponse,
	RawToolCall,
} from "../../../providers/backboard/types.ts";
import { errorMessage } from "../../../utils/errors.ts";
import type { UsageInfo } from "../../bus/events.ts";
import {
	DEFAULT_RLM_MAX_ITERATIONS,
	DEFAULT_RLM_MAX_LLM_CALLS,
	DEFAULT_RLM_MAX_OUTPUT_CHARS,
	DEFAULT_RLM_TIMEOUT_SUMMARY_MS,
} from "./RLMConstants.ts";
import { extractCodeBlock, extractReasoning } from "./RLMProtocol.ts";
import type {
	JSONObject,
	LLMBridge,
	RLMDeps,
	RLMExecObservation,
	RLMResult,
	RLMRunParams,
	RLMTrajectoryEntry,
} from "./RLMTypes.ts";

export { extractCodeBlock } from "./RLMProtocol.ts";
export type {
	RLMDeps,
	RLMResult,
	RLMRunParams,
	RLMTrajectoryEntry,
} from "./RLMTypes.ts";

/**
 * DSPy-style Recursive Language Model loop implemented with Backboard R-CLI's Backboard
 * client and local JavaScript REPL.
 */
export class RLMLoop {
	private readonly maxIterations: number;
	private readonly maxLLMCalls: number;
	private readonly maxOutputChars: number;
	private readonly timeoutSummaryMs: number;

	constructor(private readonly deps: RLMDeps) {
		this.maxIterations = deps.maxIterations ?? DEFAULT_RLM_MAX_ITERATIONS;
		this.maxLLMCalls = deps.maxLLMCalls ?? DEFAULT_RLM_MAX_LLM_CALLS;
		this.maxOutputChars = deps.maxOutputChars ?? DEFAULT_RLM_MAX_OUTPUT_CHARS;
		this.timeoutSummaryMs =
			deps.timeoutSummaryMs ?? DEFAULT_RLM_TIMEOUT_SUMMARY_MS;
	}

	async run(params: RLMRunParams): Promise<RLMResult> {
		const usage: Required<UsageInfo> = blankUsage();
		const trajectory: RLMTrajectoryEntry[] = [];
		const budget = RLMBudget.start(params.signal, params.timeoutMs);
		let llmCallCount = 0;
		const reserveLLMCalls = (count: number): void => {
			budget.throwIfExpired();
			if (llmCallCount + count > this.maxLLMCalls) {
				throw new Error(`llm_query budget exceeded (${this.maxLLMCalls})`);
			}
			llmCallCount += count;
		};
		const bridge = this.buildBridge(usage, budget.signal, reserveLLMCalls);
		const variables = buildRunVariables(params.prompt, params.variables);

		try {
			await this.deps.executor.init({
				context: params.prompt,
				variables,
				bridge,
			});

			let threadId = "";
			let lastAssistant = "";

			for (let iteration = 0; iteration < this.maxIterations; iteration++) {
				if (params.signal.aborted) {
					return {
						report: lastAssistant,
						status: "cancelled",
						usage,
						rounds: iteration,
						trajectory,
					};
				}
				budget.throwIfExpired();

				const action = await this.generateAction({
					prompt: params.prompt,
					variables,
					trajectory,
					iteration,
					threadId,
					usage,
					signal: budget.signal,
					onThread: (id) => {
						threadId = id;
					},
				});
				lastAssistant = action.raw;

				if (action.nativeToolError) {
					trajectory.push({
						reasoning: action.reasoning,
						code: "",
						output: action.nativeToolError,
					});
					continue;
				}

				const code = action.code;
				if (!code.trim()) {
					trajectory.push({
						reasoning: action.reasoning,
						code,
						output: RLM_MISSING_CODE_MESSAGE,
					});
					continue;
				}

				let result: RLMExecObservation;
				try {
					result = await this.deps.executor.execute({
						code,
						signal: budget.signal,
						timeoutMs: budget.remainingMs,
					});
				} catch (err) {
					if (err instanceof Error && budget.isTimeoutError(err)) {
						trajectory.push({
							reasoning: action.reasoning,
							code,
							output: err.message,
						});
					}
					throw err;
				}
				const output = rlmExecutionResultMessage(result, this.maxOutputChars);

				trajectory.push({
					reasoning: action.reasoning,
					code,
					output,
				});

				if ("submitted" in result) {
					return {
						report: rlmSubmittedReport(result.submitted ?? null),
						status: params.signal.aborted ? "cancelled" : "completed",
						usage,
						rounds: iteration + 1,
						trajectory,
					};
				}
			}

			const report = await this.extractFallback({
				prompt: params.prompt,
				trajectory,
				usage,
				signal: params.signal,
			});
			return {
				report,
				status: params.signal.aborted ? "cancelled" : "completed",
				usage,
				rounds: this.maxIterations,
				trajectory,
			};
		} catch (err) {
			if (err instanceof Error && budget.isTimeoutError(err)) {
				return {
					report: await this.summarizeTimeout({
						prompt: params.prompt,
						trajectory,
						usage,
						timeoutMs: budget.timeoutMs ?? 0,
						reason: err.message,
						parentSignal: params.signal,
						signal: AbortSignal.any([
							params.signal,
							AbortSignal.timeout(this.timeoutSummaryMs),
						]),
					}),
					status: params.signal.aborted ? "cancelled" : "timed_out",
					usage,
					rounds: trajectory.length,
					trajectory,
				};
			}
			throw err;
		} finally {
			budget.dispose();
			await this.deps.executor.dispose();
		}
	}

	private buildBridge(
		usage: Required<UsageInfo>,
		runSignal: AbortSignal,
		reserveLLMCalls: (count: number) => void,
	): LLMBridge {
		const single = async (prompt: string): Promise<string> => {
			if (!prompt.trim()) throw new Error("llm_query prompt must not be empty");
			reserveLLMCalls(1);
			return this.completeText({
				content: prompt,
				usage,
				signal: runSignal,
			});
		};
		return {
			llm: (prompt) => single(prompt),
			llmBatch: (prompts) => {
				if (!Array.isArray(prompts)) {
					throw new Error("llm_query_batched prompts must be an array");
				}
				for (const prompt of prompts) {
					if (!prompt.trim()) {
						throw new Error(
							"llm_query_batched prompts must not contain empty strings",
						);
					}
				}
				reserveLLMCalls(prompts.length);
				return Promise.all(
					prompts.map((prompt) =>
						this.completeText({
							content: prompt,
							usage,
							signal: runSignal,
						}),
					),
				);
			},
		};
	}

	private async generateAction(input: {
		prompt: string;
		variables: JSONObject;
		trajectory: RLMTrajectoryEntry[];
		iteration: number;
		threadId: string;
		usage: Required<UsageInfo>;
		signal?: AbortSignal;
		onThread?: (id: string) => void;
	}): Promise<{
		raw: string;
		reasoning: string;
		code: string;
		nativeToolError?: string;
	}> {
		const resp = await this.completeRaw({
			content: rlmActionPrompt({
				prompt: input.prompt,
				variables: input.variables,
				trajectory: input.trajectory,
				iteration: input.iteration,
				maxIterations: this.maxIterations,
				maxOutputChars: this.maxOutputChars,
			}),
			threadId: input.threadId || undefined,
			usage: input.usage,
			signal: input.signal,
			onThread: input.onThread,
		});

		const nativeToolError = nativeToolCallError(resp.tool_calls);
		if (nativeToolError) {
			return {
				raw: resp.content ?? "",
				reasoning: "",
				code: "",
				nativeToolError,
			};
		}

		const raw = resp.content ?? "";
		return {
			raw,
			reasoning: extractReasoning(raw),
			code: extractCodeBlock(raw) ?? "",
		};
	}

	private async extractFallback(input: {
		prompt: string;
		trajectory: RLMTrajectoryEntry[];
		usage: Required<UsageInfo>;
		signal?: AbortSignal;
	}): Promise<string> {
		const resp = await this.completeRaw({
			content: rlmExtractPrompt(input.prompt, input.trajectory),
			usage: input.usage,
			signal: input.signal,
		});
		const nativeToolError = nativeToolCallError(resp.tool_calls);
		if (nativeToolError) return nativeToolError;
		return (resp.content ?? "").trim();
	}

	private async summarizeTimeout(input: {
		prompt: string;
		trajectory: RLMTrajectoryEntry[];
		usage: Required<UsageInfo>;
		timeoutMs: number;
		reason: string;
		parentSignal: AbortSignal;
		signal: AbortSignal;
	}): Promise<string> {
		if (input.parentSignal.aborted)
			return "RLM run cancelled before completion.";
		try {
			const resp = await this.completeRaw({
				content: rlmTimedOutSummaryPrompt({
					prompt: input.prompt,
					trajectory: input.trajectory,
					timeoutMs: input.timeoutMs,
					reason: input.reason,
				}),
				usage: input.usage,
				signal: input.signal,
			});
			const nativeToolError = nativeToolCallError(resp.tool_calls);
			if (nativeToolError) return nativeToolError;
			const content = (resp.content ?? "").trim();
			return (
				content ||
				`RLM timed out after ${Math.ceil(input.timeoutMs / 1000)} seconds before producing a summary.`
			);
		} catch (err) {
			if (input.parentSignal.aborted)
				return "RLM run cancelled before completion.";
			return `RLM timed out after ${Math.ceil(input.timeoutMs / 1000)} seconds before producing a summary: ${errorMessage(err)}`;
		}
	}

	private async completeText(input: {
		content: string;
		usage: Required<UsageInfo>;
		signal?: AbortSignal;
	}): Promise<string> {
		const resp = await this.completeRaw(input);
		const nativeToolError = nativeToolCallError(resp.tool_calls);
		return nativeToolError ?? resp.content ?? "";
	}

	private async completeRaw(input: {
		content: string;
		usage: Required<UsageInfo>;
		threadId?: string;
		signal?: AbortSignal;
		onThread?: (id: string) => void;
	}): Promise<BackboardResponse> {
		const resp = await this.deps.client.sendMessage(
			{
				content: input.content,
				thread_id: input.threadId,
				llm_provider: this.deps.model.provider,
				model_name: this.deps.model.model,
			},
			input.signal ? { signal: input.signal } : {},
		);
		if (resp.thread_id) input.onThread?.(resp.thread_id);
		addUsage(input.usage, resp);
		return resp;
	}
}

function blankUsage(): Required<UsageInfo> {
	return {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		cachedTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0,
		contextTokens: 0,
		contextLimit: 0,
		model: "",
		provider: "",
	};
}

function addUsage(
	usage: Required<UsageInfo>,
	resp: {
		input_tokens?: number | null;
		output_tokens?: number | null;
		total_tokens?: number | null;
		model_name?: string | null;
		model_provider?: string | null;
	},
): void {
	usage.inputTokens += resp.input_tokens ?? 0;
	usage.outputTokens += resp.output_tokens ?? 0;
	usage.totalTokens += resp.total_tokens ?? 0;
	if (resp.model_name) usage.model = resp.model_name;
	if (resp.model_provider) usage.provider = resp.model_provider;
}

function nativeToolCallError(calls: RawToolCall[] | null): string | undefined {
	if (!calls || calls.length === 0) return undefined;
	return rlmNativeToolCallMessage(calls.map((call) => call.function.name));
}

function buildRunVariables(prompt: string, variables?: JSONObject): JSONObject {
	return {
		task: prompt,
		...(variables ?? {}),
	};
}

class RLMTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`RLM timed out after ${Math.ceil(timeoutMs / 1000)} seconds`);
		this.name = "RLMTimeoutError";
	}
}

class RLMBudget {
	private readonly controller = new AbortController();
	private readonly timeout: ReturnType<typeof setTimeout> | null = null;
	private readonly abortFromParent: () => void;
	private readonly deadlineMs: number;
	private timedOut = false;

	private constructor(
		private readonly parentSignal: AbortSignal,
		readonly timeoutMs?: number,
	) {
		this.deadlineMs =
			timeoutMs === undefined
				? Number.POSITIVE_INFINITY
				: Date.now() + timeoutMs;
		this.abortFromParent = (): void => {
			this.controller.abort(parentSignal.reason);
		};
		if (parentSignal.aborted) {
			this.abortFromParent();
		} else {
			parentSignal.addEventListener("abort", this.abortFromParent, {
				once: true,
			});
		}

		if (timeoutMs !== undefined) {
			this.timeout = setTimeout(() => {
				this.timedOut = true;
				this.controller.abort(new RLMTimeoutError(timeoutMs));
			}, timeoutMs);
		}
	}

	static start(parentSignal: AbortSignal, timeoutMs?: number): RLMBudget {
		return new RLMBudget(parentSignal, timeoutMs);
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	get remainingMs(): number | undefined {
		if (this.timeoutMs === undefined) return undefined;
		if (this.timedOut) return 1;
		return Math.max(1, this.deadlineMs - Date.now());
	}

	throwIfExpired(): void {
		if (this.timedOut) {
			throw new RLMTimeoutError(this.timeoutMs ?? 0);
		}
		if (this.signal.aborted && !this.parentSignal.aborted) {
			throw this.signal.reason instanceof Error
				? this.signal.reason
				: new RLMTimeoutError(this.timeoutMs ?? 0);
		}
	}

	isTimeoutError(error: Error): boolean {
		return (
			error instanceof RLMTimeoutError ||
			(!this.parentSignal.aborted && this.signal.aborted && this.timedOut)
		);
	}

	dispose(): void {
		if (this.timeout) clearTimeout(this.timeout);
		this.parentSignal.removeEventListener("abort", this.abortFromParent);
	}
}
