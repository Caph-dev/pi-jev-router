import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export interface RouterConfig {
	strategy: "fixed" | "adaptive" | "record";
	diagnostics: { record: boolean };
	adaptive: {
		handoffTools: string[];
		handoffPolicy: "guarded" | "first-write";
		handoffThreshold: number;
		maxHandoffContextTokens: number;
		decisionTimeoutMs: number;
		downgradeThreshold: number;
		minDwellTurns: number;
		historyMaxTurns: number;
		historyCharLimit: number;
	};
	/** Provider that holds the physical models. */
	provider: string;
	models: {
		/** Planning model for demanding work. */
		complex: string;
		/** Planning model otherwise, and the fallback when the classifier is unavailable. */
		standard: string;
		/** Implementation model. `null` keeps every request on the planning model. */
		implementation: string | null;
		/** Model for requests outside the agent loop. `null` follows `implementation`, then `standard`. */
		direct: string | null;
	};
	virtual: {
		/** Provider the virtual model is listed under. Any id pi has no physical model for always works. */
		provider: string;
		id: string;
		name: string;
		/** Levels offered for selection. Defaults to the set every Codex model supports. */
		thinkingLevels: readonly ModelThinkingLevel[];
		/** Limits shown before the first response; afterwards pi adopts the routed model's limits. */
		contextWindow: number;
		maxTokens: number;
	};
	/** Classifier that rates the planning prompt. `null` disables classification. */
	classifier: {
		provider: string;
		id: string;
		/** Divides label logits before normalizing; adapters that read label probabilities apply it. */
		temperature?: number;
		/** Local deadline for one classifier call; overrides `adaptive.decisionTimeoutMs`. */
		timeoutMs?: number;
	} | null;
	/** Probability at or above which a prompt counts as complex. */
	threshold: number;
	/** Characters of the last user message sent to the classifier. */
	promptLimit: number;
	debug: boolean;
}
