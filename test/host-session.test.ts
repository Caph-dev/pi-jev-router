/** Real public SessionManager, with a deterministic classifier/catalog. No agent-loop claims. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";
import factory, { summarizeClassifierUsage } from "../extensions/jev-router.ts";

const hostPath = process.env.PI_ROUTER_HOST_MODULE;
// A configured broken import must fail, rather than silently turning into a skip.
const host = hostPath ? await import(hostPath.startsWith("/") ? pathToFileURL(hostPath).href : hostPath) : undefined;
const saved = process.env.JEV_ROUTER_CONFIG;
const dirs: string[] = [];
afterEach(() => {
	if (saved === undefined) delete process.env.JEV_ROUTER_CONFIG;
	else process.env.JEV_ROUTER_CONFIG = saved;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function assistant(text: string) {
	return { role: "assistant", api: "test", provider: "p", model: "mid", stopReason: "stop", timestamp: Date.now(),
		content: [{ type: "text", text }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function nativeUser(text: string) { return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() }; }
function stateOf(manager: any) {
	return manager.getBranch().findLast((entry: any) => entry.type === "custom" && entry.customType === "pi.virtual-model-state" && entry.data?.provider === "jev" && entry.data?.modelId === "auto")?.data.state;
}
function setup(history = false, patch: any = {}) {
	const dir = mkdtempSync(join(tmpdir(), "jev-host-")); dirs.push(dir);
	const configFile = join(dir, "jev-router.json");
	writeFileSync(configFile, JSON.stringify({ strategy: "adaptive", provider: "p", models: { complex: "strong", standard: "mid", implementation: "cheap" },
		adaptive: { contextMode: history ? "recent-conversation" : "last-user-only" }, ...patch }));
	process.env.JEV_ROUTER_CONFIG = configFile;
	let definition: any, activeManager: any, usage: any;
	(factory as any)({ registerVirtualModel: (value: any) => { definition = value; }, getSettings: () => ({}),
		appendEntry: (type: string, data: any) => activeManager.appendCustomEntry(type, data) });
	const models = new Map(["strong", "mid", "cheap"].map(id => [id, { id, provider: "p", contextWindow: 1000, maxTokens: 100 }]));
	const inputs: any[] = [];
	let probability = 0.1;
	return { dir, inputs, models, set probability(value: number) { probability = value; }, set usage(value: any) { usage = value; },
		async dispatch(manager: any, reason = "user", extra: any = {}) {
			activeManager = manager;
			const state = stateOf(manager);
			const result = await definition.route({ reason, state, thinkingLevel: "medium", messages: host.convertToLlm(manager.buildSessionProjection().messages), ...extra }, {
				sessionManager: manager,
			getContextUsage: () => ({ tokens: 100 }),
				modelRegistry: {
					find: (provider: string, id: string) => provider === "p" ? models.get(id) : undefined,
					findOfType: () => ({ provider: "typesafe", id: "jev-latest" }),
					classify: async (_model: any, input: any) => { inputs.push(input.state); return { stopReason: "stop", answers: { complexity: { type: "choice", probabilities: { complex: probability } } }, usage }; },
				},
			});
			if (result.state !== undefined && result.state !== state)
				manager.appendCustomEntry("pi.virtual-model-state", { provider: "jev", modelId: "auto", state: result.state });
			return result;
		},
	};
}

const hostOptions = { skip: host ? false : "set PI_ROUTER_HOST_MODULE to the installed pi public entry" };
describe("real SessionManager final fixed integration", () => {
	it("fixed classifies visible native text despite converted custom messages", hostOptions, async () => {
		const h = setup(false, { strategy: "fixed" }); const manager = host.SessionManager.inMemory(h.dir);
		const user = manager.appendMessage(nativeUser("RAW_SECRET"));
		manager.appendContextEdit(user, { content: [{ type: "text", text: "visible" }] });
		manager.appendCustomMessageEntry("injected", "CUSTOM_SECRET", false);
		await h.dispatch(manager); assert.deepEqual(h.inputs, [{ prompt: "visible" }]);
	});
	it("fixed retry and missing-model repair survive reopen without a delayed handoff", hostOptions, async () => {
		const h = setup(false, { strategy: "fixed" }); h.probability = 1;
		const manager = host.SessionManager.create(h.dir, h.dir); manager.appendMessage(nativeUser("first"));
		await h.dispatch(manager);
		manager.appendMessage({ role: "toolResult", toolCallId: "w", toolName: "write", isError: false, content: [], timestamp: Date.now() });
		const retry = await h.dispatch(manager, "retry", { failed: { model: h.models.get("strong"), thinkingLevel: "high" } });
		assert.equal(retry.model.id, "strong"); assert.equal(retry.thinkingLevel, "high");
		const reopened = host.SessionManager.open(manager.getSessionFile(), h.dir);
		assert.equal((await h.dispatch(reopened, "continuation")).model.id, "strong"); assert.equal(h.inputs.length, 1);
		h.models.delete("strong"); await h.dispatch(reopened, "continuation");
		const repaired = host.SessionManager.open(reopened.getSessionFile(), h.dir);
		assert.equal(stateOf(repaired).model, "mid"); assert.equal(stateOf(repaired).handoff, "locked");
		assert.equal((await h.dispatch(repaired, "continuation")).model.id, "mid");
	});
});

describe("real SessionManager T57–T61", () => {
	it("T61 persists ledger across reopen, compaction and ancestor fork without duplicating calls", hostOptions, async () => {
		const h = setup(); h.usage = { input: 10, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 15 };
		const manager = host.SessionManager.create(h.dir, h.dir); manager.appendMessage(nativeUser("first"));
		await h.dispatch(manager); const ancestor = manager.getLeafId();
		const initial = summarizeClassifierUsage(manager); assert.equal(initial.calls, 1); assert.equal(initial.tokens.totalTokens, 15);
		const reopened = host.SessionManager.open(manager.getSessionFile(), h.dir);
		await h.dispatch(reopened, "continuation"); assert.deepEqual(summarizeClassifierUsage(reopened), initial); assert.equal(h.inputs.length, 1);
		const second = reopened.appendMessage(nativeUser("complex")); h.probability = 1; await h.dispatch(reopened);
		assert.equal(summarizeClassifierUsage(reopened).calls, 2); assert.equal(summarizeClassifierUsage(reopened).tokens.totalTokens, 30);
		reopened.appendCompaction("summary", second, 1000); assert.equal(summarizeClassifierUsage(reopened).calls, 2);
		const source = host.SessionManager.open(reopened.getSessionFile(), h.dir);
		const forkPath = source.createBranchedSession(ancestor); const fork = host.SessionManager.open(forkPath, h.dir);
		assert.deepEqual(summarizeClassifierUsage(fork), initial); assert.equal(summarizeClassifierUsage(reopened).calls, 2);
		assert.doesNotMatch(JSON.stringify(reopened.buildSessionProjection().messages), /classifier-usage|callId/);
	});
	it("T57 persists JSON state, reopens and deduplicates the same user", hostOptions, async () => {
		const h = setup(); const manager = host.SessionManager.create(h.dir, h.dir);
		const userId = manager.appendMessage(nativeUser("first"));
		await h.dispatch(manager); const state = stateOf(manager);
		assert.equal(state.lastEvaluatedUserEntryId, userId); assert.equal(state.stageStartEntryId, userId);
		assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
		const reopened = host.SessionManager.open(manager.getSessionFile(), h.dir);
		assert.deepEqual(stateOf(reopened), state);
		const count = reopened.getBranch().length; const result = await h.dispatch(reopened);
		assert.equal(result.model.id, "mid"); assert.equal(reopened.getBranch().length, count); assert.equal(h.inputs.length, 1);
	});
	it("T58 restores different leaf states and a persisted fork without branch contamination", hostOptions, async () => {
		const h = setup(); const manager = host.SessionManager.create(h.dir, h.dir);
		manager.appendMessage(nativeUser("first")); await h.dispatch(manager); const planningLeaf = manager.getLeafId();
		manager.appendMessage({ role: "toolResult", toolCallId: "outer", toolName: "codemode", isError: true, content: [], timestamp: Date.now(),
			nestedCalls: { complete: false, calls: [{ id: "outer/1", name: "write", status: "ok", durationMs: 1 }] } });
		await h.dispatch(manager, "continuation"); const cheapLeaf = manager.getLeafId();
		assert.equal(stateOf(manager).model, "cheap"); assert.equal(stateOf(manager).stageSeq, 2);
		manager.branch(planningLeaf); manager.appendMessage(nativeUser("complex branch")); h.probability = 1;
		await h.dispatch(manager); assert.equal(stateOf(manager).model, "strong"); const strongLeaf = manager.getLeafId();
		manager.branch(cheapLeaf); assert.equal((await h.dispatch(manager, "continuation")).model.id, "cheap");
		manager.branch(strongLeaf); assert.equal((await h.dispatch(manager, "continuation")).model.id, "strong");
		const forkPath = manager.createBranchedSession(strongLeaf);
		const fork = host.SessionManager.open(forkPath, h.dir);
		assert.equal(stateOf(fork).model, "strong"); assert.equal(stateOf(fork).handoff, "locked"); assert.equal(h.inputs.length, 2);
	});
	it("T59 compaction preserves branch state and only projected kept turns reach classifier", hostOptions, async () => {
		const h = setup(true); const manager = host.SessionManager.create(h.dir, h.dir);
		manager.appendMessage(nativeUser("OLD_USER_SECRET")); manager.appendMessage(assistant("OLD_ASSISTANT_SECRET"));
		const kept = manager.appendMessage(nativeUser("kept")); await h.dispatch(manager);
		manager.appendMessage(assistant("kept answer"));
		manager.appendCompaction("SUMMARY_SECRET", kept, 1000);
		manager.appendMessage(nativeUser("next"));
		assert.equal(stateOf(manager).model, "mid"); await h.dispatch(manager);
		const input = h.inputs.at(-1);
		assert.deepEqual(input, { current: "next", recentTurns: [{ user: "kept", assistant: ["kept answer"] }], historyPartial: true });
		assert.doesNotMatch(JSON.stringify(input), /OLD_USER_SECRET|OLD_ASSISTANT_SECRET|SUMMARY_SECRET/);
		assert.equal(stateOf(manager).stageSeq, 1); assert.equal(stateOf(manager).handoff, "locked");
	});
	it("T60 context edits replace/delete visible text without resending original user or assistant bodies", hostOptions, async () => {
		const h = setup(true); const manager = host.SessionManager.inMemory(h.dir);
		const user = manager.appendMessage(nativeUser("RAW_USER_SECRET"));
		const answer = manager.appendMessage(assistant("RAW_ASSISTANT_SECRET"));
		manager.appendContextEdit(user, { content: [{ type: "text", text: "replaced" }] });
		manager.appendContextEdit(answer, null);
		manager.appendMessage(assistant("visible answer"));
		manager.appendCustomMessageEntry("injected", "CUSTOM_SECRET", false);
		const current = manager.appendMessage(nativeUser("RAW_CURRENT_SECRET"));
		manager.appendContextEdit(current, { content: [{ type: "text", text: "visible current" }] });
		await h.dispatch(manager);
		assert.deepEqual(h.inputs[0], { current: "visible current", recentTurns: [{ user: "replaced", assistant: ["visible answer"] }], historyPartial: true });
		assert.doesNotMatch(JSON.stringify(h.inputs), /RAW_USER_SECRET|RAW_ASSISTANT_SECRET|RAW_CURRENT_SECRET|CUSTOM_SECRET/);
		manager.appendContextEdit(current, null);
		await h.dispatch(manager); assert.equal(h.inputs.length, 1); assert.equal(stateOf(manager).lastEvaluatedUserEntryId, current);
	});
});
