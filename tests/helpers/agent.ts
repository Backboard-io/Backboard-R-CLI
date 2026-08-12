import type { ModelRef } from "../../src/config/defaults.ts";
import type { BackboardEnv } from "../../src/config/env.ts";

export const TEST_MODEL: ModelRef = { provider: "openai", model: "gpt-5.5" };

export const TEST_BACKBOARD_ENV: BackboardEnv = {
	apiKey: "k",
	apiUrl: "https://example.test/api",
};
