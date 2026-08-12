import type { JSONObject, RLMExecObservation } from "./RLMTypes.ts";

export type LocalReplWorkerRequest =
	| {
			type: "init";
			id: number;
			context: string;
			variables?: JSONObject;
	  }
	| { type: "execute"; id: number; code: string; timeoutMs?: number }
	| { type: "dispose"; id: number }
	| { type: "llmResponse"; requestId: number; value: string | string[] }
	| { type: "llmError"; requestId: number; error: string };

export type LocalReplWorkerResponse =
	| { type: "ready"; id: number }
	| { type: "executeResult"; id: number; result: RLMExecObservation }
	| { type: "disposed"; id: number }
	| { type: "error"; id: number; error: string }
	| {
			type: "llmRequest";
			requestId: number;
			kind: "single";
			prompt: string;
	  }
	| {
			type: "llmRequest";
			requestId: number;
			kind: "batch";
			prompts: string[];
	  };
