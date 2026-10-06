/**
 * pi-jev-router - a virtual pi model that plans on a strong model and implements on a cheap one.
 *
 * Registers a virtual model (default `jev/auto`) that routes each request between three physical
 * models:
 *
 * - Planning: the *complex* model for demanding work, the *standard* model otherwise. The Jev
 *   classifier rates the last user message; planning stays on the chosen model.
 * - Implementation: the *implementation* model (default `gpt-6-luna`).
 *
 * The planning model explores, plans, and makes the first edit. After the first successful `edit`
 * or `write` tool call, the next request of the same turn goes to the implementation model, and the
 * session stays there. A session therefore switches models once and accepts a single prompt-cache
 * miss.
 *
 * The phase is router state: pi stores it on the session branch, so it follows the session tree and
 * survives compaction. Thinking levels come from `modelThinkingLevels` in pi's settings, keyed by
 * the physical model that actually runs the request. Requests outside the agent loop, such as
 * compaction summaries, go to the implementation model (`models.direct` overrides that).
 *
 * Configuration, first match wins, each file merged over the previous one:
 *
 *   1. `$JEV_ROUTER_CONFIG`          explicit config file; when set, no other file is read
 *   2. `~/.pi/agent/jev-router.json` personal config
 *   3. `<cwd>/.pi/jev-router.json`   project config (overrides the personal one)
 *
 * A missing file is fine; a malformed one fails loudly at startup. See `jev-router.example.json`
 * and the README for every key.
 *
 * Requirements: at least two configured models for planning. The classifier is optional: without
 * TypeSafe credentials, planning always uses the standard model.
 *
 * Usage:
 *   pi -e ./extensions/jev-router.ts --model jev/auto   (one-off, no install)
 *   pi install ./path/to/pi-jev-router                  (as a package)
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Message, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";

const PACKAGE_NAME = "pi-jev-router";
const CONFIG_FILE_NAME = "jev-router.json";
const CONFIG_ENV = "JEV_ROUTER_CONFIG";
const DEBUG_ENV = "JEV_ROUTER_DEBUG";

/** Tools whose successful result means implementation has started. */
const EDIT_TOOLS = new Set(["edit", "write"]);

const ALL_THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface RouterConfig {
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
	/** Jev classifier that rates the planning prompt. `null` disables classification. */
	classifier: { provider: string; id: string } | null;
	/** Probability at or above which a prompt counts as complex. */
	threshold: number;
	/** Characters of the last user message sent to the classifier. */
	promptLimit: number;
	debug: boolean;
}

const DEFAULT_CONFIG: RouterConfig = {
	provider: "openai-codex",
	models: {
		complex: "gpt-6-astra",
		standard: "gpt-6.1-sol",
		implementation: "gpt-6-luna",
		direct: null,
	},
	virtual: {
		provider: "jev",
		id: "auto",
		name: "Auto (Jev)",
		thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
		contextWindow: 272_000,
		maxTokens: 128_000,
	},
	classifier: { provider: "typesafe", id: "jev-latest" },
	threshold: 0.5,
	promptLimit: 16_000,
	debug: false,
};

interface RouterState {
	phase: "planning" | "implementation";
	/** Physical model for this phase. */
	model: string;
}

type RouterRequest = ModelRouteRequest<RouterState>;

function fail(message: string): never {
	throw new Error(`${PACKAGE_NAME}: ${message}`);
}

function warn(message: string): void {
	console.error(`${PACKAGE_NAME}: ${message}`);
}

/** pi's agent directory, resolved the same way the host does: env override, then `~/.pi/agent`. */
function agentDir(): string {
	return process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
}

function configFileCandidates(): string[] {
	const explicit = process.env[CONFIG_ENV]?.trim();
	if (explicit) return [explicit];
	return [join(agentDir(), CONFIG_FILE_NAME), join(process.cwd(), ".pi", CONFIG_FILE_NAME)];
}

function readConfigFile(path: string): Record<string, unknown> | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
		fail(`cannot read config file ${path}: ${String(cause)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (cause) {
		fail(`config file ${path} is not valid JSON: ${String(cause)}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		fail(`config file ${path} must contain a JSON object`);
	return parsed as Record<string, unknown>;
}

function stringField(value: unknown, path: string, key: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || value.trim() === "") fail(`${path}: "${key}" must be a non-empty string`);
	return value.trim();
}

function numberField(value: unknown, path: string, key: string, min: number, max: number): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
		fail(`${path}: "${key}" must be a number between ${min} and ${max}`);
	return value;
}

function booleanField(value: unknown, path: string, key: string): boolean | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "boolean") fail(`${path}: "${key}" must be true or false`);
	return value;
}

function objectField(value: unknown, path: string, key: string): Record<string, unknown> {
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value)) fail(`${path}: "${key}" must be an object`);
	return value as Record<string, unknown>;
}

/** A model id, or `null`/`false` to disable the slot. */
function optionalModelField(
	container: Record<string, unknown>,
	path: string,
	key: string,
	fallback: string | null,
): string | null {
	if (!(key in container)) return fallback;
	const value = container[key];
	if (value === null || value === false) return null;
	if (typeof value !== "string" || value.trim() === "") fail(`${path}: "models.${key}" must be a model id or null`);
	return value.trim();
}

function thinkingLevelsField(value: unknown, path: string): ModelThinkingLevel[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value) || value.length === 0) fail(`${path}: "virtual.thinkingLevels" must be a non-empty array`);
	return value.map((entry) => {
		if (typeof entry !== "string" || !ALL_THINKING_LEVELS.includes(entry as ModelThinkingLevel))
			fail(`${path}: "virtual.thinkingLevels" contains ${JSON.stringify(entry)}; allowed: ${ALL_THINKING_LEVELS.join(", ")}`);
		return entry as ModelThinkingLevel;
	});
}

const CONFIG_KEYS = new Set(["provider", "models", "virtual", "classifier", "threshold", "promptLimit", "debug"]);

function mergeConfig(base: RouterConfig, path: string): { config: RouterConfig; found: boolean } {
	const patch = readConfigFile(path);
	if (!patch) return { config: base, found: false };
	for (const key of Object.keys(patch))
		if (!CONFIG_KEYS.has(key)) warn(`${path}: ignoring unknown key ${JSON.stringify(key)}`);

	const models = objectField(patch.models, path, "models");
	const virtual = objectField(patch.virtual, path, "virtual");

	let classifier = base.classifier;
	const classifierValue = patch.classifier;
	if (classifierValue === null || classifierValue === false) classifier = null;
	else if (classifierValue !== undefined) {
		const container = objectField(classifierValue, path, "classifier");
		classifier = {
			provider: stringField(container.provider, path, "classifier.provider") ?? base.classifier?.provider ?? "typesafe",
			id: stringField(container.id, path, "classifier.id") ?? base.classifier?.id ?? "jev-latest",
		};
	}

	return {
		found: true,
		config: {
			provider: stringField(patch.provider, path, "provider") ?? base.provider,
			models: {
				complex: stringField(models.complex, path, "models.complex") ?? base.models.complex,
				standard: stringField(models.standard, path, "models.standard") ?? base.models.standard,
				implementation: optionalModelField(models, path, "implementation", base.models.implementation),
				direct: optionalModelField(models, path, "direct", base.models.direct),
			},
			virtual: {
				provider: stringField(virtual.provider, path, "virtual.provider") ?? base.virtual.provider,
				id: stringField(virtual.id, path, "virtual.id") ?? base.virtual.id,
				name: stringField(virtual.name, path, "virtual.name") ?? base.virtual.name,
				thinkingLevels: thinkingLevelsField(virtual.thinkingLevels, path) ?? base.virtual.thinkingLevels,
				contextWindow:
					numberField(virtual.contextWindow, path, "virtual.contextWindow", 1, Number.MAX_SAFE_INTEGER) ??
					base.virtual.contextWindow,
				maxTokens:
					numberField(virtual.maxTokens, path, "virtual.maxTokens", 1, Number.MAX_SAFE_INTEGER) ?? base.virtual.maxTokens,
			},
			classifier,
			threshold: numberField(patch.threshold, path, "threshold", 0, 1) ?? base.threshold,
			promptLimit: numberField(patch.promptLimit, path, "promptLimit", 1, 1_000_000) ?? base.promptLimit,
			debug: booleanField(patch.debug, path, "debug") ?? base.debug,
		},
	};
}

function loadConfig(): { config: RouterConfig; files: string[] } {
	let config = DEFAULT_CONFIG;
	const files: string[] = [];
	for (const path of configFileCandidates()) {
		const merged = mergeConfig(config, path);
		config = merged.config;
		if (merged.found) files.push(path);
	}
	return { config, files };
}

function lastUserText(messages: readonly Message[]): string {
	const content = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** Whether a tool call since the last user message edited a file successfully. */
function editedThisTurn(messages: readonly Message[]): boolean {
	const lastUser = messages.findLastIndex((message) => message.role === "user");
	return messages
		.slice(lastUser + 1)
		.some((message) => message.role === "toolResult" && EDIT_TOOLS.has(message.toolName) && !message.isError);
}

/** Thinking level for the routed model: an explicit virtual-model entry wins over the model's own. */
function dispatchLevel(pi: ExtensionAPI, request: RouterRequest, config: RouterConfig, id: string): ModelThinkingLevel {
	const levels: Record<string, ModelThinkingLevel> = pi.getSettings()?.modelThinkingLevels ?? {};
	return (
		levels[`${config.virtual.provider}/${config.virtual.id}`] ??
		levels[`${config.provider}/${id}`] ??
		request.thinkingLevel
	);
}

export default function (pi: ExtensionAPI) {
	const { config, files } = loadConfig();
	const debug = config.debug || Boolean(process.env[DEBUG_ENV]);
	const log = (message: string) => {
		if (debug) console.error(`[${PACKAGE_NAME}] ${message}`);
	};
	const implementation = config.models.implementation;
	const direct = config.models.direct ?? implementation ?? config.models.standard;

	log(`config: ${files.length > 0 ? files.join(", ") : "built-in defaults"}`);
	log(
		`planning ${config.provider}/${config.models.complex} | ${config.provider}/${config.models.standard}` +
			` → ${implementation ? `${config.provider}/${implementation}` : "no implementation phase"}`,
	);

	const definition = {
		provider: config.virtual.provider,
		id: config.virtual.id,
		name: config.virtual.name,
		thinkingLevels: config.virtual.thinkingLevels,
		// Shown before the first response; pi adopts the routed model's limits afterwards.
		contextWindow: config.virtual.contextWindow,
		maxTokens: config.virtual.maxTokens,
		async route(request: RouterRequest, ctx: ExtensionContext): Promise<ModelRoute<RouterState>> {
			/** Adopt the routed model's limits so the declared ones stay honest before the first response. */
			const syncLimits = (model: { contextWindow: number; maxTokens: number }) => {
				if (model.contextWindow === definition.contextWindow && model.maxTokens === definition.maxTokens) return;
				try {
					pi.registerVirtualModel({ ...definition, contextWindow: model.contextWindow, maxTokens: model.maxTokens });
					definition.contextWindow = model.contextWindow;
					definition.maxTokens = model.maxTokens;
				} catch (cause) {
					log(`could not update the declared limits: ${String(cause)}`);
				}
			};

			const route = (id: string, state?: RouterState) => {
				const model = ctx.modelRegistry.find(config.provider, id);
				if (!model)
					fail(
						`model ${config.provider}/${id} is not in the catalog. Set "provider" and "models" in ` +
							`${files.length > 0 ? files.join(" or ") : `~/.pi/agent/${CONFIG_FILE_NAME}`} to models you have configured.`,
					);
				syncLimits(model);
				const thinkingLevel = dispatchLevel(pi, request, config, id);
				log(
					`${request.reason} → ${config.provider}/${id} • ${thinkingLevel}` +
						` • ctx ${model.contextWindow}/${model.maxTokens}`,
				);
				return { model, thinkingLevel, state };
			};
			/** A state model can disappear when the config changes; fall back to the standard model. */
			const pickState = (id: string) => {
				if (ctx.modelRegistry.find(config.provider, id)) return route(id);
				log(`state model ${config.provider}/${id} is not in the catalog; using ${config.models.standard}`);
				return route(config.models.standard);
			};

			if (request.reason === "direct") return route(direct);

			const state = request.state;
			if (!state) {
				const model = await choosePlanningModel();
				return route(model, { phase: "planning", model });
			}
			// The planning model made the first edit: hand the rest of the work to the implementation model.
			if (implementation && state.phase === "planning" && editedThisTurn(request.messages))
				return route(implementation, { phase: "implementation", model: implementation });
			return pickState(state.model);

			async function choosePlanningModel(): Promise<string> {
				// Keep a planning model the session already uses, so switching to the virtual model costs no cache miss.
				const previous = request.previous?.model;
				if (
					previous?.provider === config.provider &&
					(previous.id === config.models.complex || previous.id === config.models.standard)
				) {
					log(`keeping ${config.provider}/${previous.id} for planning (latest response)`);
					return previous.id;
				}
				if (!config.classifier) return config.models.standard;

				const jev = ctx.modelRegistry.findOfType("classifier", config.classifier.provider, config.classifier.id);
				if (!jev) {
					log(`no ${config.classifier.provider}/${config.classifier.id} classifier; using ${config.models.standard}`);
					return config.models.standard;
				}

				const prompt = lastUserText(request.messages).slice(0, config.promptLimit);
				let result: Awaited<ReturnType<typeof ctx.modelRegistry.classify>>;
				try {
					result = await ctx.modelRegistry.classify(
						jev,
						{
							state: { prompt },
							questions: {
								complexity: {
									type: "choice",
									instructions:
										"How demanding is the software engineering work requested in `prompt`? " +
										"Choose `complex` when the user asks for the strongest model.",
									criteria: {
										standard: "Ordinary features, fixes, reviews, or questions",
										complex: "Subtle design, cross-cutting changes, or hard debugging",
									},
								},
							},
						},
						{ signal: request.signal },
					);
				} catch (cause) {
					log(`classify failed (${String(cause)}); using ${config.models.standard}`);
					return config.models.standard;
				}

				const answer = result.stopReason === "stop" ? result.answers.complexity : undefined;
				if (!answer || answer.type !== "choice") {
					log(`classifier did not answer (${result.stopReason}); using ${config.models.standard}`);
					return config.models.standard;
				}
				const probability = answer.probabilities.complex ?? 0;
				const model = probability >= config.threshold ? config.models.complex : config.models.standard;
				log(`classify → ${config.provider}/${model} (complex p=${probability.toFixed(3)}, threshold ${config.threshold})`);
				return model;
			}
		},
	};

	pi.registerVirtualModel(definition);
}
