const STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"you",
	"your",
	"this",
	"that",
	"from",
	"into",
	"want",
	"need",
	"make",
	"use",
	"using",
	"how",
	"can",
	"should",
	"about",
	"then",
	"when",
	"what",
	"server",
	"skill",
]);

/** Lowercase alphanumeric tokens of length >= 3, minus stopwords. */
export function tokenize(text: string): Set<string> {
	const tokens = new Set<string>();
	for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
		if (raw.length >= 3 && !STOPWORDS.has(raw)) tokens.add(raw);
	}
	return tokens;
}

/** Task relevance: strong-text token hits score strongWeight, weak-text hits score 1. */
export function keywordScore(
	taskTokens: ReadonlySet<string>,
	strong: string,
	weak = "",
	strongWeight = 3,
): number {
	const strongTokens = tokenize(strong);
	const weakTokens = tokenize(weak);
	let score = 0;
	for (const token of taskTokens) {
		if (strongTokens.has(token)) score += strongWeight;
		else if (weakTokens.has(token)) score += 1;
	}
	return score;
}
