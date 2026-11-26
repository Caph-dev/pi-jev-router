import { createHash } from "node:crypto";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRouteRequest } from "@earendil-works/pi-coding-agent";

import type { RouterConfig } from "./router-config.ts";
import { matchesConfigIgnoringDirect, routingConfigIdentity } from "./config-identity.ts";
import { selectRetryTarget } from "./retry-target.ts";
import { buildClassifierInput, currentUser, hasSuccessfulWriteAfterBoundary, type ClassifierInput } from "./session-input.ts";

export interface RouterState {
	phase: "planning" | "implementation";
	/** Physical model for this phase. */
	model: string;
	provider?: string;
	handoff?: "first-write" | "locked";
	stageStartEntryId?: string | null;
	record?: RecordState;
	/** Pre-2.0 name for `record`, still read from sessions saved by older versions. */
	shadow?: RecordState;
}

interface RecordState {
	lastEvaluatedUserEntryId: string | null;
	configKey: string;
}

export const ADAPTIVE_POLICY_VERSION = "adaptive-v4";

type PlanningSlot = "complex" | "standard" | "retained";
type PlanningState = { slot: PlanningSlot; model: string };

interface AdaptiveStateBase extends RouterState {
	schemaVersion: 1;
	strategy: "adaptive";
	provider: string;
	slot: PlanningSlot | "implementation";
	stageSeq: number;
	stageStartEntryId: string | null;
	handoff: "first-write" | "locked";
	lastEvaluatedUserEntryId: string | null;
	configKey: string;
	turnsInSlot: number;
	lastCompactionEntryId: string | null;
	handoffEvidence?: { inputKey: string; probability: number };
}

export interface AdaptiveState extends AdaptiveStateBase {
	policyVersion: typeof ADAPTIVE_POLICY_VERSION;
	// model/slot describe the active dispatch; planning survives a handoff or a retry.
	planning: PlanningState;
}

type SavedAdaptiveState = AdaptiveState | (AdaptiveStateBase & { policyVersion: "adaptive-v1" | "adaptive-v2" | "adaptive-v3" });

export type RouterRequest = ModelRouteRequest<RouterState | SavedAdaptiveState>;
export type Branch = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;
export type Projection = ReturnType<ExtensionContext["sessionManager"]["buildSessionProjection"]>;

function modelSlot(config: RouterConfig, state: RouterState): AdaptiveState["slot"] {
	if (state.phase === "implementation" && state.model === config.models.implementation) return "implementation";
	if (state.phase === "planning" && state.model === config.models.complex) return "complex";
	if (state.phase === "planning" && state.model === config.models.standard) return "standard";
	return "retained";
}

function planningSlot(config: RouterConfig, id: string): PlanningSlot {
	if (id === config.models.complex) return "complex";
	if (id === config.models.standard) return "standard";
	return "retained";
}

function standardPlan(config: RouterConfig): PlanningState {
	return { slot: "standard", model: config.models.standard };
}

function latestCompaction(branch: Branch): string | null {
	return branch.findLast(entry => entry.type === "compaction")?.id ?? null;
}

type BoundaryDecisionReason = "compaction-unavailable" | "keep-unavailable" | "compaction-upgrade" | "upgrade" |
	"compaction-downgrade" | "downgrade" | "compaction-hold" | "hold-dwell" | "keep-simple";

export type AdaptiveDecisionReason = BoundaryDecisionReason | "keep-state" | "state-recovered" | "retry-sticky" |
	"previous-reused" | "initial" | "target-missing" | "handoff-no-evidence" | "handoff-context-large" |
	"handoff-context-unknown" | "handoff-model-unavailable" | "initial-write" | "already-evaluated";

function boundaryDecision(point: "user" | "compaction", slot: PlanningSlot, result: ComplexityAssessment,
	complete: boolean, turns: number, config: RouterConfig): { slot: PlanningSlot; reason: BoundaryDecisionReason } {
	if (result.kind !== "classified") return { slot, reason: point === "compaction" ? "compaction-unavailable" : "keep-unavailable" };
	if (result.probability >= config.threshold && slot !== "complex")
		return { slot: "complex", reason: point === "compaction" ? "compaction-upgrade" : "upgrade" };
	if (slot === "complex" && complete && result.probability <= config.adaptive.downgradeThreshold) {
		if (turns >= config.adaptive.minDwellTurns) return { slot: "standard", reason: point === "compaction" ? "compaction-downgrade" : "downgrade" };
		return { slot, reason: point === "compaction" ? "compaction-hold" : "hold-dwell" };
	}
	return { slot, reason: point === "compaction" ? "compaction-hold" : "keep-simple" };
}

/** Normalize locally; no state is committed until route returns successfully. */
function normalizeAdaptiveState(raw: RouterState | SavedAdaptiveState | undefined, config: RouterConfig,
	key: string, branch: Branch, leaf: string | null, exists: (id: string) => boolean): AdaptiveState | "invalid-state" | undefined {
	if (raw === undefined) return undefined;
	if (!raw || typeof raw !== "object" || !["planning", "implementation"].includes(raw.phase) ||
		typeof raw.model !== "string" || !raw.model.trim()) return "invalid-state";
	let state: AdaptiveState;
	if (!("schemaVersion" in raw)) {
		const slot = modelSlot(config, raw);
		const planning = raw.phase === "planning" && slot !== "implementation" ? { slot, model: raw.model } : standardPlan(config);
		state = { ...raw, schemaVersion: 1, policyVersion: ADAPTIVE_POLICY_VERSION, strategy: "adaptive",
			provider: config.provider, slot, planning, stageSeq: 1,
			stageStartEntryId: leaf, handoff: "locked", lastEvaluatedUserEntryId: null, configKey: key,
			turnsInSlot: config.adaptive.minDwellTurns, lastCompactionEntryId: latestCompaction(branch) };
	} else {
		if (raw.schemaVersion !== 1 || !["adaptive-v1", "adaptive-v2", "adaptive-v3", ADAPTIVE_POLICY_VERSION].includes(raw.policyVersion) || raw.strategy !== "adaptive" ||
			typeof raw.provider !== "string" || !raw.provider || typeof raw.configKey !== "string" ||
			!Number.isSafeInteger(raw.stageSeq) || raw.stageSeq < 1 ||
			!["complex", "standard", "implementation", "retained"].includes(raw.slot) ||
			!["first-write", "locked"].includes(raw.handoff) ||
			![raw.stageStartEntryId, raw.lastEvaluatedUserEntryId].every(id => id === null || (typeof id === "string" && id.length > 0))) return "invalid-state";
		if ((raw.phase === "implementation" && !["implementation", "retained"].includes(raw.slot)) ||
			(raw.phase === "planning" && raw.slot === "implementation") ||
			(raw.handoff === "first-write" && raw.phase !== "planning")) return "invalid-state";
		const compatible = matchesConfigIgnoringDirect(raw.configKey, key);
		const samePolicy = compatible && raw.provider === config.provider;
		if (samePolicy && exists(raw.model) && raw.slot !== "retained" && config.models[raw.slot] !== raw.model) return "invalid-state";
		if (raw.handoffEvidence !== undefined && (!raw.handoffEvidence || typeof raw.handoffEvidence.inputKey !== "string" ||
			!Number.isFinite(raw.handoffEvidence.probability) || raw.handoffEvidence.probability < 0 || raw.handoffEvidence.probability > 1)) return "invalid-state";
		const hasBoundaryState = raw.policyVersion === "adaptive-v3" || raw.policyVersion === ADAPTIVE_POLICY_VERSION;
		if (hasBoundaryState && (!Number.isSafeInteger(raw.turnsInSlot) || raw.turnsInSlot < 0 ||
			!(raw.lastCompactionEntryId === null || (typeof raw.lastCompactionEntryId === "string" && raw.lastCompactionEntryId.length > 0)))) return "invalid-state";
		const configKey = compatible ? key : raw.configKey;
		if (raw.policyVersion === ADAPTIVE_POLICY_VERSION) {
			const plan = raw.planning;
			if (!plan || !["complex", "standard", "retained"].includes(plan.slot) || typeof plan.model !== "string" || !plan.model.trim()) return "invalid-state";
			if (samePolicy && plan.slot !== "retained" && config.models[plan.slot] !== plan.model) return "invalid-state";
			if (raw.handoff === "first-write" && (plan.slot !== "standard" ||
				(exists(raw.model) && (plan.model !== raw.model || raw.slot !== plan.slot)))) return "invalid-state";
			state = configKey === raw.configKey ? raw : { ...raw, configKey };
		} else {
			const oldPlan = raw.phase === "planning" && raw.slot !== "implementation" ? { slot: raw.slot, model: raw.model } : undefined;
			const planning = oldPlan ?? standardPlan(config);
			state = { ...raw, configKey, policyVersion: ADAPTIVE_POLICY_VERSION, planning,
				turnsInSlot: hasBoundaryState ? (oldPlan ? raw.turnsInSlot : 0) : config.adaptive.minDwellTurns,
				...(!hasBoundaryState ? { handoff: "locked", handoffEvidence: undefined, lastCompactionEntryId: latestCompaction(branch) } : {}) };
		}
	}
	const sameProvider = state.provider === config.provider;
	const activeAvailable = sameProvider && exists(state.model);
	const planAvailable = sameProvider && exists(state.planning.model);
	if (state.configKey !== key || !activeAvailable || !planAvailable) {
		const oldPlan = state.planning;
		const planning = planAvailable ? {
			model: oldPlan.model,
			slot: oldPlan.slot !== "retained" && config.models[oldPlan.slot] === oldPlan.model ? oldPlan.slot : planningSlot(config, oldPlan.model),
		} : standardPlan(config);
		const slot = activeAvailable && state.slot !== "retained" && config.models[state.slot] === state.model ? state.slot : modelSlot(config, state);
		state = { ...state, configKey: key, provider: config.provider, handoff: "locked", handoffEvidence: undefined, stageStartEntryId: leaf, planning,
			model: activeAvailable ? state.model : planning.model, phase: activeAvailable ? state.phase : "planning",
			slot: activeAvailable ? slot : planning.slot,
			turnsInSlot: planning.slot === oldPlan.slot && planning.model === oldPlan.model ? state.turnsInSlot : 0 };
	}
	if ((state.stageStartEntryId === null || !branch.some(entry => entry.id === state.stageStartEntryId)) && state.handoff !== "locked") {
		state = { ...state, handoff: "locked", handoffEvidence: undefined };
	}
	return state;
}

export type UnavailableReason = "disabled" | "missing-classifier" | "timeout" | "error" | "invalid-answer" | "missing-input";
export type ClassifierUsage = { tokens: Record<string, number>; cost: number | "unknown" };
export type ComplexityAssessment = (
	| { kind: "classified"; probability: number; durationMs: number }
	| { kind: "unavailable"; reason: UnavailableReason; durationMs: number }) & { usage?: ClassifierUsage; api?: string };

export async function routeAdaptive(request: RouterRequest, config: RouterConfig, host: {
	branch: Branch;
	leaf: string | null;
	projection: () => Projection;
	exists: (id: string) => boolean;
	estimateContextTokens: () => number | undefined;
	assess: (input: ClassifierInput) => Promise<ComplexityAssessment>;
}) {
	const { branch, leaf, projection, exists, estimateContextTokens, assess } = host;
	const implementation = config.models.implementation;
	let decisionReason: AdaptiveDecisionReason = "keep-state";
	const compaction = latestCompaction(branch);
	const key = routingConfigIdentity(config);
	let candidate = normalizeAdaptiveState(request.state, config, key, branch, leaf, exists);
	if (candidate === "invalid-state") return { kind: "invalid-state" } as const;
	if (candidate !== request.state) decisionReason = "state-recovered";
	const projected = projection();
	const user = currentUser(projected);
	const input = buildClassifierInput(config, projected, branch, user);
	const inputKey = createHash("sha256").update(JSON.stringify(input)).digest("hex");
	const completeInput = Boolean(user?.text.trim() && !user.hasImages && user.text.length <= config.promptLimit);
	const guardedEvidence = (slot: AdaptiveState["slot"], result: ComplexityAssessment | undefined) =>
		slot === "standard" && completeInput && result?.kind === "classified" &&
		result.probability < config.threshold && result.probability <= config.adaptive.handoffThreshold
			? { inputKey, probability: result.probability } : undefined;
	const createState = (id: string, handoff: AdaptiveState["handoff"], slot: PlanningSlot): AdaptiveState => ({
		phase: "planning", model: id, schemaVersion: 1, policyVersion: ADAPTIVE_POLICY_VERSION, strategy: "adaptive",
		provider: config.provider, slot, planning: { slot, model: id }, stageSeq: 1,
		stageStartEntryId: leaf, handoff, lastEvaluatedUserEntryId: user?.id ?? null, configKey: key,
		turnsInSlot: 0, lastCompactionEntryId: compaction,
	});
	const finish = (state: AdaptiveState, level?: ModelThinkingLevel) => {
		request.signal?.throwIfAborted();
		const original = request.state;
		if (original && "schemaVersion" in original) {
			const changed = original.model !== state.model || original.phase !== state.phase || original.slot !== state.slot ||
				!matchesConfigIgnoringDirect(original.configKey, state.configKey) || original.provider !== state.provider;
			state = { ...state, stageSeq: original.stageSeq + (changed ? 1 : 0),
				stageStartEntryId: changed ? leaf : state.stageStartEntryId };
			if (original.policyVersion === ADAPTIVE_POLICY_VERSION && JSON.stringify(state) === JSON.stringify(original)) state = original;
		}
		return { kind: "routed" as const, state, reason: decisionReason, thinkingLevel: level };
	};
	const previousPlanning = () => {
		const model = request.previous?.model;
		return model?.provider === config.provider && [config.models.complex, config.models.standard].includes(model.id) &&
			exists(model.id) ? model.id : undefined;
	};
	if (request.reason === "retry") {
		decisionReason = "retry-sticky";
		const previous = candidate ? undefined : previousPlanning();
		const { id, keepsFailed, thinkingLevel } = selectRetryTarget(request, config, candidate?.model, exists, previous);
		if (candidate && id === candidate.model) return finish(candidate, thinkingLevel);
		const state = candidate ?? createState(previous ?? config.models.standard, "locked", previous ? planningSlot(config, previous) : "standard");
		const phase = id === implementation && (candidate || keepsFailed) ? "implementation" : "planning";
		const slot = phase === "planning" && id === state.planning.model ? state.planning.slot : modelSlot(config, { model: id, phase });
		return finish({ ...state, model: id, phase, slot, handoff: "locked", handoffEvidence: undefined,
			stageStartEntryId: leaf }, thinkingLevel);
	}
	if (!candidate) {
		let id = previousPlanning();
		decisionReason = id ? "previous-reused" : "initial";
		let slot: PlanningSlot = id === config.models.complex ? "complex" : "standard";
		let assessment: ComplexityAssessment | undefined;
		if (!id && request.reason === "user") {
			const result = assessment = await assess(input);
			slot = result.kind === "classified" && result.probability >= config.threshold ? "complex" : "standard";
			id = config.models[slot];
		}
		const evidence = guardedEvidence(slot, assessment);
		const firstWrite = slot === "standard" && request.reason === "user" && user && leaf && branch.some(entry => entry.id === leaf) && implementation && config.adaptive.handoffTools.length > 0 &&
			(config.adaptive.handoffPolicy === "first-write" || evidence !== undefined);
		const state = createState(id ?? config.models.standard, firstWrite ? "first-write" : "locked", slot);
		if (firstWrite && evidence) state.handoffEvidence = evidence;
		return finish(state);
	}
	const newUser = request.reason === "user" && user && user.id !== candidate.lastEvaluatedUserEntryId;
	const pendingCompaction = compaction !== null && compaction !== candidate.lastCompactionEntryId;
	if (newUser || ((request.reason === "user" || request.reason === "continuation") && pendingCompaction)) {
		const point = newUser ? "user" : "compaction";
		const turns = candidate.turnsInSlot + (newUser ? 1 : 0);
		const result = await assess(input);
		const previousPlan = candidate.planning;
		const decision = boundaryDecision(point, previousPlan.slot, result, completeInput, turns, config);
		decisionReason = decision.reason;
		let planning = previousPlan;
		if (decision.slot !== previousPlan.slot && decision.slot !== "retained") {
			const target = config.models[decision.slot];
			if (exists(target)) planning = { slot: decision.slot, model: target };
			else decisionReason = "target-missing";
		}
		const evidence = guardedEvidence(planning.slot, result);
		const enable = planning.slot === "standard" && Boolean(user && leaf && implementation && config.adaptive.handoffTools.length) &&
			(config.adaptive.handoffPolicy === "first-write" || evidence !== undefined);
		candidate = { ...candidate, planning, model: planning.model, phase: "planning", slot: planning.slot,
			turnsInSlot: planning === previousPlan ? turns : 0, lastCompactionEntryId: compaction,
			lastEvaluatedUserEntryId: newUser ? user!.id : candidate.lastEvaluatedUserEntryId,
			handoff: enable ? "first-write" : "locked", handoffEvidence: enable ? evidence : undefined,
			stageStartEntryId: enable ? leaf : candidate.stageStartEntryId };
	} else if (request.reason === "continuation" && candidate.handoff === "first-write" && candidate.phase === "planning" && implementation &&
		hasSuccessfulWriteAfterBoundary(branch, candidate, user?.id, config.adaptive.handoffTools)) {
		if (config.adaptive.handoffPolicy === "guarded") {
			const evidence = candidate.handoffEvidence;
			if (!completeInput || candidate.slot !== "standard" || !evidence || evidence.inputKey !== inputKey ||
				evidence.probability >= config.threshold || evidence.probability > config.adaptive.handoffThreshold) {
				decisionReason = "handoff-no-evidence";
				return finish({ ...candidate, handoff: "locked" });
			}
			const tokens = estimateContextTokens();
			if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0 || tokens > config.adaptive.maxHandoffContextTokens) {
				decisionReason = typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? "handoff-context-large" : "handoff-context-unknown";
				return finish(candidate);
			}
		}
		decisionReason = "handoff-model-unavailable";
		if (exists(implementation)) {
			decisionReason = "initial-write";
			candidate = { ...candidate, model: implementation, phase: "implementation", slot: "implementation", handoff: "locked", handoffEvidence: undefined };
		}
	}
	if (decisionReason === "keep-state" && request.reason === "user") decisionReason = "already-evaluated";
	return finish(candidate);
}
