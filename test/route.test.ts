/**
 * Route-path tests for the messages a user sees when the config does not match their catalog.
 *
 * The extension is driven through a stub `pi` and `ctx`: a partial object is enough for the paths
 * under test, and type checking is not run over this file.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import factory from "../extensions/jev-router.ts";

const CONFIG_ENV = "JEV_ROUTER_CONFIG";
const AGENT_ENV = "PI_CODING_AGENT_DIR";

const saved = { explicit: process.env[CONFIG_ENV], agentDir: process.env[AGENT_ENV] };
const tempDirs: string[] = [];

function tempDir(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "jev-router-route-")));
	tempDirs.push(dir);
	return dir;
}

function write(dir: string, value: unknown): string {
	const path = join(dir, "jev-router.json");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2));
	return path;
}

type Definition = {
	provider: string;
	id: string;
	contextWindow: number;
	maxTokens: number;
	route: (request: any, ctx: any) => Promise<{ model: any; thinkingLevel: string; state?: any }>;
};

/** Load the extension against a stub and return the definition it registered. */
function register(levels = {}): Definition {
	let definition: Definition | undefined;
	const pi = {
		registerVirtualModel: (value: Definition) => void (definition = value),
		getSettings: () => ({ modelThinkingLevels: levels }),
	};
	// The stub covers the members the extension touches on the paths under test.
	(factory as unknown as (pi: typeof pi) => void)(pi);
	assert.ok(definition, "the extension did not register a virtual model");
	return definition;
}

/** A `ctx` whose catalog holds `ids`, or nothing at all. Model objects are stable references. */
function context(ids: string[], provider = "p") {
	const catalog = new Map(ids.map((id) => [id, { id, provider, contextWindow: 1000, maxTokens: 100 }]));
	return {
		modelRegistry: {
			catalog,
			find: (_provider: string, id: string) => catalog.get(id),
			findOfType: () => undefined,
		},
	};
}

function request(reason: string, extra: Record<string, unknown> = {}) {
	return { reason, messages: [], thinkingLevel: "medium", ...extra };
}

afterEach(() => {
	if (saved.explicit === undefined) delete process.env[CONFIG_ENV];
	else process.env[CONFIG_ENV] = saved.explicit;
	if (saved.agentDir === undefined) delete process.env[AGENT_ENV];
	else process.env[AGENT_ENV] = saved.agentDir;
	for (let dir = tempDirs.pop(); dir; dir = tempDirs.pop()) rmSync(dir, { recursive: true, force: true });
});

describe("registration", () => {
	it("registers jev/auto with the declared limits", () => {
		process.env[CONFIG_ENV] = join(tempDir(), "missing.json");
		const definition = register();
		assert.equal(definition.provider, "jev");
		assert.equal(definition.id, "auto");
		assert.equal(definition.contextWindow, 272_000);
		assert.equal(definition.maxTokens, 128_000);
	});
});

describe("missing models", () => {
	it("points at the personal config file and at pi --list-models", async () => {
		const agentDir = tempDir();
		process.env[AGENT_ENV] = agentDir;
		process.env[CONFIG_ENV] = join(agentDir, "missing.json");

		await assert.rejects(
			() => register().route(request("user"), context([])),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				// No classifier and no models: the router falls back to the standard model, per the README.
				assert.match(error.message, /openai-codex\/gpt-6\.1-sol is not in the catalog/);
				assert.match(error.message, /pi --list-models/);
				assert.ok(error.message.includes(join(agentDir, "jev-router.json")), error.message);
				assert.match(error.message, /\$JEV_ROUTER_CONFIG/);
				return true;
			},
		);
	});

	it("points at the config file that was read", async () => {
		const path = write(tempDir(), { provider: "anthropic", models: { complex: "absent", standard: "absent" } });
		process.env[CONFIG_ENV] = path;

		await assert.rejects(
			() => register().route(request("user"), context([])),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /anthropic\/absent is not in the catalog/);
				assert.ok(error.message.includes(path), error.message);
				return true;
			},
		);
	});
});

describe("direct requests", () => {
	it("follows standard when the implementation phase is off", async () => {
		process.env[CONFIG_ENV] = write(tempDir(), {
			provider: "p",
			models: { complex: "strong", standard: "mid", implementation: null },
		});
		const ctx = context(["strong", "mid"]);
		const route = await register().route(request("direct"), ctx);
		assert.equal(route.model, ctx.modelRegistry.catalog.get("mid"));
	});

	it("routes direct requests to the implementation model", async () => {
		process.env[CONFIG_ENV] = write(tempDir(), {
			provider: "p",
			models: { complex: "strong", standard: "mid", implementation: "cheap" },
		});
		const ctx = context(["strong", "mid", "cheap"]);
		const route = await register().route(request("direct"), ctx);
		assert.equal(route.model, ctx.modelRegistry.catalog.get("cheap"));
	});
});

const slots = { complex: "strong", standard: "mid", implementation: "cheap" };
const choice = (probability: number) => ({ stopReason: "stop", answers: { complexity: { type: "choice", probabilities: { complex: probability } } } });

/** Save changed route state before simulated downstream work, matching the host contract. */
function harness(patch: any = {}, levels = {}) {
	process.env[CONFIG_ENV] = write(tempDir(), { provider: "p", models: slots, ...patch });
	const definition = register(levels);
	const ctx: any = context(["strong", "mid", "cheap"]);
	ctx.getContextUsage = () => ({ tokens: 100 });
	const branch: any[] = [];
	let projection: any[] | undefined;
	let result: any = choice(0.8);
	const calls: any[] = [];
	ctx.modelRegistry.findOfType = () => ({ provider: "typesafe", id: "jev-latest", cost: { input: 0, output: 0 } });
	ctx.modelRegistry.classify = async (...args: any[]) => {
		calls.push(args);
		return typeof result === "function" ? result(...args) : result;
	};
	ctx.sessionManager = {
		getBranch: () => branch,
		getLeafId: () => branch.at(-1)?.id ?? null,
		buildSessionProjection: () => ({ entries: projection ?? branch.map(sourceEntry => ({ sourceEntry, messages: sourceEntry.message ? [sourceEntry.message] : [] })) }),
	};
	let state: any;
	let writes = 0;
	let serial = 0;
	const add = (message: any) => { const entry = { type: "message", id: "e" + ++serial, message }; branch.push(entry); return entry; };
	return {
		definition, ctx, branch, calls, add,
		user: (text = "task") => add({ role: "user", content: [{ type: "text", text }], timestamp: 0 }),
		set result(value: any) { result = value; },
		get projection() { return projection!; }, set projection(value: any[]) { projection = value; },
		get state() { return state; }, set state(value: any) { state = value; },
		get writes() { return writes; },
		async dispatch(reason = "user", extra: any = {}) {
			const routed = await definition.route(request(reason, { state, messages: branch.flatMap(e => e.message ? [e.message] : []), ...extra }), ctx);
			if (routed.state !== undefined && routed.state !== state) { state = routed.state; writes++; }
			return routed;
		},
	};
}

describe("final fixed boundaries", () => {
	for (const timing of ["before", "during", "return", "service", "throw"]) it("fixed cancellation " + timing + " returns no state", async () => {
		const h = harness(); h.user(); const controller = new AbortController();
		if (timing === "before") controller.abort();
		else if (timing === "during") h.result = () => { controller.abort(); return new Promise(() => {}); };
		else if (timing === "return") h.result = () => { controller.abort(); return choice(1); };
		else if (timing === "service") h.result = { stopReason: "aborted" };
		else h.result = () => { throw new DOMException("cancelled", "AbortError"); };
		await assert.rejects(() => h.dispatch("user", { signal: controller.signal }), { name: "AbortError" });
		assert.equal(h.writes, 0);
	});
	it("fixed retry keeps the failed model and thinking even after a successful write", async () => {
		const h = harness(); h.user(); await h.dispatch();
		h.add({ role: "toolResult", toolName: "write", isError: false });
		const routed = await h.dispatch("retry", { failed: { model: h.ctx.modelRegistry.catalog.get("strong"), thinkingLevel: "high" } });
		assert.equal(routed.model.id, "strong"); assert.equal(routed.thinkingLevel, "high");
		assert.equal(h.calls.length, 1);
		assert.equal((await h.dispatch("continuation")).model.id, "strong");
	});
	it("fixed retry without state never classifies", async () => {
		const h = harness(); h.user();
		const r = await h.dispatch("retry", { failed: { model: h.ctx.modelRegistry.catalog.get("cheap"), thinkingLevel: "high" } });
		assert.equal(r.model.id, "cheap"); assert.equal(r.thinkingLevel, "high"); assert.equal(h.calls.length, 0);
	});
	it("fixed repairs missing state before considering old writes", async () => {
		const h = harness(); h.user(); h.state = { phase: "planning", model: "gone" };
		h.add({ role: "toolResult", toolName: "write", isError: false });
		assert.equal((await h.dispatch("continuation")).model.id, "mid"); assert.equal(h.state.model, "mid");
		assert.equal((await h.dispatch("continuation")).model.id, "mid");
	});
	for (const strategy of ["fixed", "adaptive"]) it(strategy + " retains planning when implementation is missing", async () => {
		const h = harness({ strategy }); h.user(); h.result = choice(0.1); await h.dispatch();
		h.ctx.modelRegistry.catalog.delete("cheap"); h.add({ role: "toolResult", toolName: "write", isError: false });
		assert.equal((await h.dispatch("continuation")).model.id, "mid");
	});
	it("fixed uses projected native text and excludes injected messages", async () => {
		const h = harness(); const sourceEntry = h.user("RAW_SECRET");
		h.projection = [{ sourceEntry, messages: [{ role: "user", content: "visible" }] }];
		await h.dispatch("user", { messages: [{ role: "user", content: "CUSTOM_SECRET" }] });
		assert.deepEqual(h.calls[0][1].state, { prompt: "visible" });
	});
	it("fixed with no projection sends nothing to the classifier", async () => {
		const h = harness(); h.user(); delete h.ctx.sessionManager;
		assert.equal((await h.dispatch()).model.id, "mid"); assert.equal(h.calls.length, 0);
	});
	it("fixed bounds classification, disables SDK retries and ignores late results", async () => {
		const h = harness({ adaptive: { decisionTimeoutMs: 2 } }); h.user();
		h.result = () => new Promise(resolve => setTimeout(() => resolve(choice(1)), 30));
		assert.equal((await h.dispatch()).model.id, "mid");
		assert.equal(h.calls[0][2].maxRetries, 0); assert.equal(h.calls[0][2].signal.aborted, true);
		const state = h.state; await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(h.state, state);
	});
	for (const p of [Infinity, -1, 2, NaN]) it("fixed invalid probability " + p + " falls back to standard", async () => {
		const h = harness(); h.user(); h.result = choice(p); assert.equal((await h.dispatch()).model.id, "mid");
	});
});

describe("fixed characterization T01–T06", () => {
	it("keeps strong → cheap → cheap across later user requests", async () => {
		const h = harness(); h.user();
		assert.equal((await h.dispatch()).model.id, "strong");
		h.add({ role: "toolResult", toolName: "write", isError: true });
		assert.equal((await h.dispatch("continuation")).model.id, "strong");
		h.add({ role: "toolResult", toolName: "codemode", nestedCalls: { calls: [{ name: "write", status: "ok" }] } });
		assert.equal((await h.dispatch("continuation")).model.id, "cheap");
		h.add({ role: "toolResult", toolName: "edit", isError: false });
		assert.equal((await h.dispatch("continuation")).model.id, "cheap");
		h.user("harder");
		assert.equal((await h.dispatch()).model.id, "cheap");
		assert.equal(h.calls.length, 1); assert.equal(h.writes, 2);
	});
	for (const [label, result, expected] of [
		["outer success alone", { toolName: "codemode", isError: false }, "strong"],
		["nested error", { toolName: "codemode", nestedCalls: { calls: [{ name: "write", status: "error" }] } }, "strong"],
		["nested unfinished", { toolName: "codemode", nestedCalls: { calls: [{ name: "edit", status: "unfinished" }] } }, "strong"],
		["nested read", { toolName: "codemode", nestedCalls: { calls: [{ name: "read", status: "ok" }] } }, "strong"],
		["outer error with nested write", { toolName: "codemode", isError: true, nestedCalls: { complete: false, calls: [{ name: "write", status: "ok" }] } }, "cheap"],
		["nested edit", { toolName: "codemode", nestedCalls: { calls: [{ name: "edit", status: "ok" }] } }, "cheap"],
	] as const) it("fixed handoff: " + label, async () => {
		const h = harness(); h.user(); await h.dispatch();
		h.add({ role: "toolResult", ...result }); assert.equal((await h.dispatch("continuation")).model.id, expected);
		assert.equal(h.calls.length, 1);
	});
	it("fixed excludes nested writes before the current user boundary", async () => {
		const h = harness(); h.user(); await h.dispatch();
		h.add({ role: "toolResult", toolName: "codemode", nestedCalls: { calls: [{ name: "write", status: "ok" }] } });
		h.user("next task"); assert.equal((await h.dispatch("continuation")).model.id, "strong");
	});
	for (const [p, expected] of [[0.499, "mid"], [0.5, "strong"], [0.501, "strong"], [undefined, "mid"]] as const)
		it("threshold " + p + " → " + expected, async () => {
			const h = harness(); h.user(); h.result = choice(p as number);
			assert.equal((await h.dispatch()).model.id, expected);
			assert.deepEqual(h.calls[0][1].state, { prompt: "task" });
		});
	it("reuses previous planning model without classifying", async () => {
		const h = harness(); h.user();
		assert.equal((await h.dispatch("user", { previous: { model: h.ctx.modelRegistry.catalog.get("mid") } })).model.id, "mid");
		assert.equal(h.calls.length, 0);
	});
	for (const failure of [{ stopReason: "error" }, () => { throw Error("service"); }])
		it("retains initialization fallback for " + (typeof failure === "function" ? "throw" : failure.stopReason), async () => {
			const h = harness(); h.user(); h.result = failure;
			assert.equal((await h.dispatch()).model.id, "mid");
		});
	it("direct override takes priority and returns no state", async () => {
		const h = harness({ models: { ...slots, direct: "strong" } });
		assert.equal((await h.dispatch("direct")).model.id, "strong");
		assert.equal(h.writes, 0); assert.equal(h.calls.length, 0);
	});
});

describe("adaptive state normalization T43–T49", () => {
	for (const phase of ["planning", "implementation"]) it("migrates legacy " + phase + " locked at current leaf", async () => {
		const h = harness({ strategy: "adaptive" }); const user = h.user();
		h.state = { phase, model: phase === "planning" ? "strong" : "cheap" };
		await h.dispatch("continuation");
		assert.equal(h.state.schemaVersion, 1); assert.equal(h.state.phase, phase);
		assert.equal(h.state.stageSeq, 1); assert.equal(h.state.handoff, "locked");
		assert.equal(h.state.stageStartEntryId, user.id); assert.equal(h.calls.length, 0);
	});
	it("requires branch and projection only for adaptive", async () => {
		const h = harness({ strategy: "adaptive" }); delete h.ctx.sessionManager;
		await assert.rejects(() => h.dispatch(), /fixed|host/);
	});
	for (const state of [{ phase: "other", model: "mid" }, { phase: "planning", model: 1 }, { schemaVersion: 2, phase: "planning", model: "mid" }])
		it("rejects invalid/future state " + JSON.stringify(state), async () => {
			const h = harness({ strategy: "adaptive" }); h.user(); h.state = state;
			await assert.rejects(() => h.dispatch("continuation"), /state.*fixed|state.*session/);
		});
});

async function initialized(patch: any = {}, probability = 0.1) {
	const h = harness({ strategy: "adaptive", ...patch }); h.user(); h.result = choice(probability);
	await h.dispatch(); return h;
}

describe("adaptive classification T07–T24", () => {
	for (const start of ["mid", "cheap"]) it(start + " upgrades once, keeps strong on continue and writes", async () => {
		const h = await initialized();
		if (start === "cheap") { h.add({ role: "toolResult", toolName: "write", isError: false }); await h.dispatch("continuation"); }
		assert.equal(h.state.model, start);
		const seq = h.state.stageSeq; h.user("complex"); h.result = choice(0.5);
		assert.equal((await h.dispatch("user", { previous: { model: h.ctx.modelRegistry.catalog.get("mid") } })).model.id, "strong");
		assert.equal(h.state.phase, "planning"); assert.equal(h.state.handoff, "locked"); assert.equal(h.state.stageSeq, seq + 1);
		const writes = h.writes;
		h.add({ role: "toolResult", toolName: "write", isError: false });
		assert.equal((await h.dispatch("continuation")).model.id, "strong"); assert.equal(h.writes, writes);
		h.user("continue"); assert.equal((await h.dispatch()).model.id, "strong"); assert.equal(h.calls.length, 2);
	});
	it("same entry is judged once; identical text on a new ID is judged again", async () => {
		const h = await initialized(); const writes = h.writes;
		await h.dispatch(); assert.equal(h.calls.length, 1); assert.equal(h.writes, writes);
		h.user(); await h.dispatch(); assert.equal(h.calls.length, 2);
		assert.equal(h.state.stageSeq, 1); assert.equal(h.state.handoff, "locked");
	});
	for (const [label, result] of [
		["simple", choice(0.499)], ["error", { stopReason: "error", errorMessage: "SECRET" }],
		["throw", () => { throw Error("SECRET"); }], ["missing", { stopReason: "stop", answers: {} }],
		["wrong-type", { stopReason: "stop", answers: { complexity: { type: "bool" } } }],
		...[undefined, NaN, Infinity, -0.1, 1.1].map(p => ["probability-" + p, choice(p as number)]),
	] as const) it(label + " blocks initial handoff and retains existing implementation on reassessment", async () => {
		const fresh = harness({ strategy: "adaptive" }); fresh.user(); fresh.result = result;
		assert.equal((await fresh.dispatch()).model.id, "mid");
		fresh.add({ role: "toolResult", toolName: "write", isError: false });
		assert.equal((await fresh.dispatch("continuation")).model.id, "mid");
		const h = await initialized();
		h.add({ role: "toolResult", toolName: "write", isError: false }); await h.dispatch("continuation");
		h.result = result; h.user("next"); assert.equal((await h.dispatch()).model.id, "cheap");
		assert.equal(h.state.handoff, "locked"); assert.equal(h.state.stageSeq, 2);
		const calls = h.calls.length; await h.dispatch(); assert.equal(h.calls.length, calls);
	});
	for (const disabled of ["disabled", "missing-classifier"]) it(disabled + " initializes standard and never downgrades retained model", async () => {
		const h = harness({ strategy: "adaptive", ...(disabled === "disabled" ? { classifier: null } : {}) }); h.user();
		if (disabled === "missing-classifier") h.ctx.modelRegistry.findOfType = () => undefined;
		assert.equal((await h.dispatch()).model.id, "mid");
		h.state = { phase: "planning", model: "cheap" }; h.user();
		assert.equal((await h.dispatch()).model.id, "cheap"); assert.equal(h.calls.length, 0);
	});
	it("times out an uncooperative classifier, aborts it, and handles late rejection", async () => {
		const h = harness({ strategy: "adaptive", adaptive: { decisionTimeoutMs: 2 } }); h.user();
		let reject!: (error: Error) => void; let signal: AbortSignal;
		h.result = (_model: any, _input: any, options: any) => { signal = options.signal; return new Promise((_, no) => { reject = no; }); };
		assert.equal((await h.dispatch()).model.id, "mid"); assert.equal(signal!.aborted, true);
		reject(Error("late")); await new Promise(resolve => setImmediate(resolve)); assert.equal(h.writes, 1);
	});
	for (const timing of ["before", "during", "return", "service", "timeout-race"]) it("cancel " + timing + " does not save migration or consume user ID", async () => {
		const h = harness({ strategy: "adaptive", adaptive: { decisionTimeoutMs: 2 } }); h.user();
		h.state = { phase: "implementation", model: "cheap" }; const original = h.state;
		const controller = new AbortController();
		if (timing === "before") controller.abort();
		else if (timing === "during") h.result = () => { queueMicrotask(() => controller.abort()); return new Promise(() => {}); };
		else if (timing === "return") h.result = () => { controller.abort(); return choice(1); };
		else if (timing === "service") h.result = { stopReason: "aborted" };
		else h.result = (_m: any, _i: any, { signal }: any) => { signal.addEventListener("abort", () => controller.abort()); return new Promise(() => {}); };
		await assert.rejects(() => h.dispatch("user", { signal: controller.signal }), /abort|cancel/i);
		assert.equal(h.writes, 0); assert.equal(h.state, original);
		if (timing === "before") assert.equal(h.calls.length, 0);
	});
	it("initial previous planning reuse and non-user initialization never classify", async () => {
		for (const reason of ["user", "continuation"]) {
			const h = harness({ strategy: "adaptive" }); h.user();
			assert.equal((await h.dispatch(reason, { previous: { model: h.ctx.modelRegistry.catalog.get("strong") } })).model.id, "strong");
			assert.equal(h.calls.length, 0); assert.equal(h.state.lastEvaluatedUserEntryId, h.branch[0].id);
			if (reason !== "user") assert.equal(h.state.handoff, "locked");
		}
		const h = harness({ strategy: "adaptive" }); h.user();
		assert.equal((await h.dispatch("continuation")).model.id, "mid"); assert.equal(h.calls.length, 0);
	});
	it("target missing keeps existing model but initial target missing reports config", async () => {
		const h = await initialized(); h.ctx.modelRegistry.catalog.delete("strong"); h.user(); h.result = choice(1);
		assert.equal((await h.dispatch()).model.id, "mid"); assert.equal(h.state.handoff, "locked");
		const fresh = harness({ strategy: "adaptive" }); fresh.user(); fresh.ctx.modelRegistry.catalog.delete("strong");
		await assert.rejects(() => fresh.dispatch(), /catalog.*pi --list-models/);
	});
});

describe("guarded adaptive handoff", () => {
	for (const p of [0.21, 0.499, 0.5, 0.9]) it("does not hand off probability " + p, async () => {
		const h = await initialized({}, p); h.add({ role: "toolResult", toolName: "write", isError: false });
		assert.equal((await h.dispatch("continuation")).model.id, p >= 0.5 ? "strong" : "mid");
	});
	for (const tokens of [undefined, null, NaN, -1, 50001]) it("blocks unknown/large context " + tokens, async () => {
		const h = await initialized(); h.ctx.getContextUsage = () => ({ tokens });
		h.add({ role: "toolResult", toolName: "write", isError: false });
		assert.equal((await h.dispatch("continuation")).model.id, "mid");
	});
	it("accepts inclusive simple and context thresholds with successful nested writes", async () => {
		const h = await initialized({}, 0.2); h.ctx.getContextUsage = () => ({ tokens: 50000 });
		h.add({ role: "toolResult", toolName: "codemode", nestedCalls: { calls: [{ name: "write", status: "ok" }] } });
		assert.equal((await h.dispatch("continuation")).model.id, "cheap");
	});
	for (const kind of ["truncated", "image", "unavailable", "reused", "changed-projection"]) it("blocks " + kind + " without simple full input evidence", async () => {
		const h = harness({ strategy: "adaptive", ...(kind === "truncated" ? { promptLimit: 1 } : {}) }); const user = h.user("task"); h.result = choice(0.1);
		if (kind === "image") user.message.content.push({ type: "image", data: "IMAGE_SECRET" });
		if (kind === "unavailable") h.result = { stopReason: "error" };
		await h.dispatch("user", kind === "reused" ? { previous: { model: h.ctx.modelRegistry.catalog.get("mid") } } : {});
		if (kind === "changed-projection") h.projection = [{ sourceEntry: user, messages: [{ role: "user", content: "harder replacement" }] }];
		h.add({ role: "toolResult", toolName: "write", isError: false });
		assert.equal((await h.dispatch("continuation")).model.id, "mid");
	});
	it("explicit first-write policy preserves the feat initial complex handoff", async () => {
		const h = await initialized({ adaptive: { handoffPolicy: "first-write" } }, 0.9);
		h.add({ role: "toolResult", toolName: "write", isError: false });
		assert.equal((await h.dispatch("continuation")).model.id, "cheap");
	});
	it("old policy state migrates locked without reopening handoff", async () => {
		const h = await initialized(); h.state = { ...h.state, policyVersion: "adaptive-v1" };
		h.add({ role: "toolResult", toolName: "write", isError: false });
		assert.equal((await h.dispatch("continuation")).model.id, "mid"); assert.equal(h.state.handoff, "locked");
		assert.equal(h.state.policyVersion, "adaptive-v2");
	});
});

describe("handoff and branch boundaries T25–T36", () => {
	for (const [label, message, handoff] of [
		["outer ok", { toolName: "write", isError: false }, true],
		["nested ok", { toolName: "codemode", nestedCalls: { complete: true, calls: [{ name: "write", status: "ok" }] } }, true],
		["nested error", { nestedCalls: { calls: [{ name: "write", status: "error" }] } }, false],
		["nested unfinished", { nestedCalls: { calls: [{ name: "write", status: "unfinished" }] } }, false],
		["outer error nested ok", { toolName: "codemode", isError: true, nestedCalls: { calls: [{ name: "edit", status: "ok" }] } }, true],
		["incomplete ok", { nestedCalls: { complete: false, calls: [{ name: "write", status: "ok" }] } }, true],
		["incomplete empty", { nestedCalls: { complete: false, calls: [] } }, false],
		["successful bash", { toolName: "bash", isError: false, content: [{ type: "text", text: "write done" }] }, false],
		["successful codemode", { toolName: "codemode", isError: false }, false],
	] as const) it(label + " uses only persisted positive evidence", async () => {
		const h = await initialized(); h.add({ role: "toolResult", ...message });
		const seq = h.state.stageSeq; const writes = h.writes;
		assert.equal((await h.dispatch("continuation")).model.id, handoff ? "cheap" : "mid");
		assert.equal(h.state.phase, handoff ? "implementation" : "planning");
		assert.equal(h.state.stageSeq, seq + Number(handoff)); assert.equal(h.writes, writes + Number(handoff));
		await h.dispatch("continuation"); assert.equal(h.writes, writes + Number(handoff));
	});
	it("supports custom writing tools", async () => {
		const h = await initialized({ adaptive: { handoffTools: ["save"] } });
		h.add({ role: "toolResult", toolName: "save", isError: false });
		assert.equal((await h.dispatch("continuation")).model.id, "cheap");
	});
	for (const patch of [{ adaptive: { handoffTools: [] } }, { models: { ...slots, implementation: null } }])
		it("disabled handoff stays locked", async () => {
			const h = await initialized(patch); h.add({ role: "toolResult", toolName: "write", isError: false });
			assert.equal((await h.dispatch("continuation")).model.id, "mid"); assert.equal(h.state.handoff, "locked");
		});
	it("old edits and writes before the stage anchor are excluded", async () => {
		const h = harness({ strategy: "adaptive" }); h.user("old");
		h.add({ role: "toolResult", toolName: "write", isError: false }); h.user("new"); h.result = choice(0.1);
		await h.dispatch(); await h.dispatch("continuation"); assert.equal(h.state.model, "mid");
	});
	it("new user reassessment wins over the previous write and disables delayed handoff", async () => {
		const h = await initialized(); h.add({ role: "toolResult", toolName: "write", isError: false });
		h.user("continue"); h.result = choice(0.1); await h.dispatch(); await h.dispatch("continuation");
		assert.equal(h.state.model, "mid"); assert.equal(h.state.handoff, "locked"); assert.equal(h.state.stageSeq, 1);
	});
	it("missing stage anchor locks; a later new user can still upgrade", async () => {
		const h = await initialized(); h.state = { ...h.state, stageStartEntryId: "lost" };
		h.add({ role: "toolResult", toolName: "write", isError: false }); await h.dispatch("continuation");
		assert.equal(h.state.model, "mid"); assert.equal(h.state.handoff, "locked");
		h.user("complex"); h.result = choice(1); await h.dispatch(); assert.equal(h.state.model, "strong");
	});
	it("no source or empty native text never classifies converted injected user content", async () => {
		for (const native of [false, true]) {
			const h = harness({ strategy: "adaptive" });
			if (native) h.user("");
			h.branch.push({ type: "custom_message", id: "injection", content: "complex" });
			await h.dispatch("user", { messages: [{ role: "user", content: "injected" }] });
			assert.equal(h.calls.length, 0); assert.equal(h.state.model, "mid");
		}
	});
});

describe("retry and recovery T37–T49", () => {
	it("retry on same failed model locks handoff, retains thinking and limits", async () => {
		const h = await initialized({}, 0.8); const seq = h.state.stageSeq;
		const failed = { model: h.ctx.modelRegistry.catalog.get("strong"), thinkingLevel: "low" };
		const routed = await h.dispatch("retry", { failed });
		assert.equal(routed.model.id, "strong"); assert.equal(routed.thinkingLevel, "low");
		assert.equal(h.state.stageSeq, seq); assert.equal(h.state.handoff, "locked");
		assert.equal(h.calls.length, 1); assert.equal(h.definition.contextWindow, 1000); assert.equal(h.definition.maxTokens, 100);
	});
	it("different eligible failed model becomes sticky on continuation", async () => {
		const h = await initialized();
		const failed = { model: h.ctx.modelRegistry.catalog.get("cheap"), thinkingLevel: "high" };
		await h.dispatch("retry", { failed }); assert.equal(h.state.phase, "implementation"); assert.equal(h.state.stageSeq, 2);
		const writes = h.writes; assert.equal((await h.dispatch("continuation")).model.id, "cheap"); assert.equal(h.writes, writes);
	});
	for (const failed of [undefined, { model: { provider: "foreign", id: "strong" } }, { model: { provider: "p", id: "absent" } }, { model: { provider: "p", id: "unconfigured" } }])
		it("invalid/missing failed falls back to valid state", async () => {
			const h = await initialized(); h.ctx.modelRegistry.catalog.set("unconfigured", { provider: "p", id: "unconfigured" });
			assert.equal((await h.dispatch("retry", { failed })).model.id, "mid"); assert.equal(h.calls.length, 1);
		});
	it("saved upgrade survives downstream failure; retry does not reclassify or add a stage", async () => {
		const h = await initialized(); h.user(); h.result = choice(1); const route = await h.dispatch();
		assert.equal(h.state.model, "strong"); const writes = h.writes;
		await h.dispatch("retry", { failed: { model: route.model } }); assert.equal(h.calls.length, 2); assert.equal(h.writes, writes);
	});
	it("retry without state uses failed, then previous planning, then standard without classification", async () => {
		for (const source of ["failed", "previous", "none"]) {
			const h = harness({ strategy: "adaptive" }); h.user();
			const extra = source === "none" ? {} : { [source]: { model: h.ctx.modelRegistry.catalog.get(source === "failed" ? "cheap" : "strong") } };
			const routed = await h.dispatch("retry", extra);
			assert.equal(routed.model.id, source === "failed" ? "cheap" : source === "previous" ? "strong" : "mid");
			assert.equal(h.state.handoff, "locked"); assert.equal(h.calls.length, 0);
			assert.equal(h.state.phase, source === "failed" ? "implementation" : "planning");
			assert.equal(h.state.slot, source === "failed" ? "implementation" : source === "previous" ? "complex" : "standard");
		}
	});
	it("normal thinking precedence is virtual then physical then request", async () => {
		for (const [levels, expected] of [[{}, "medium"], [{ "p/mid": "high" }, "high"], [{ "p/mid": "high", "jev/auto": "low" }, "low"]] as const) {
			const h = harness({ strategy: "adaptive", classifier: null }, levels); h.user();
			assert.equal((await h.dispatch()).thinkingLevel, expected);
		}
	});
	it("same physical ID in complex and implementation changes phase once on upgrade", async () => {
		const h = await initialized({ models: { ...slots, complex: "cheap" } });
		h.add({ role: "toolResult", toolName: "write", isError: false }); await h.dispatch("continuation");
		h.user(); h.result = choice(1); await h.dispatch();
		assert.equal(h.state.model, "cheap"); assert.equal(h.state.phase, "planning"); assert.equal(h.state.slot, "complex"); assert.equal(h.state.stageSeq, 3);
	});
	it("missing state model is repaired and saved locked; missing standard reports config", async () => {
		const h = await initialized(); h.ctx.modelRegistry.catalog.delete("mid");
		h.state = { ...h.state, model: "gone" };
		await assert.rejects(() => h.dispatch("continuation"), /catalog/);
		h.ctx.modelRegistry.catalog.set("mid", { provider: "p", id: "mid", contextWindow: 2000, maxTokens: 200 });
		await h.dispatch("continuation"); assert.equal(h.state.model, "mid"); assert.equal(h.state.handoff, "locked"); assert.equal(h.state.stageSeq, 2);
	});
	it("configuration changes rebuild locked stages without rejudging old input", async () => {
		const original = await initialized(); const state = structuredClone(original.state);
		for (const patch of [{ threshold: 0.8 }, { provider: "q" }]) {
			const h = harness({ strategy: "adaptive", ...patch }); const user = h.user();
			h.state = structuredClone(state); h.state.lastEvaluatedUserEntryId = user.id;
			if (patch.provider) for (const model of h.ctx.modelRegistry.catalog.values()) model.provider = "q";
			await h.dispatch(); assert.equal(h.calls.length, 0); assert.equal(h.state.stageSeq, 2); assert.equal(h.state.handoff, "locked");
			assert.equal(h.state.provider, patch.provider ?? "p");
		}
	});
	it("unknown v1 counters and metadata fail explicitly", async () => {
		const good = await initialized();
		for (const patch of [{ stageSeq: 0 }, { stageSeq: 1.5 }, { slot: "future" }, { handoff: "maybe" }, { stageStartEntryId: 123 }, { policyVersion: "future" }, { phase: "implementation", slot: "complex" }, { slot: "complex" }, { phase: "implementation", handoff: "first-write", slot: "implementation", model: "cheap" }]) {
			const h = harness({ strategy: "adaptive" }); h.user(); h.state = { ...good.state, ...patch };
			await assert.rejects(() => h.dispatch("continuation"), /invalid adaptive state/);
		}
	});
	it("adaptive state remains consumable by fixed", async () => {
		const adaptive = await initialized({}, 0.8); const h = harness(); h.user(); h.state = adaptive.state;
		h.add({ role: "toolResult", toolName: "write", isError: false });
		assert.equal((await h.dispatch("continuation")).model.id, "cheap"); assert.equal(h.calls.length, 0);
	});
});

describe("shadow observations", () => {
	it("follows fixed routes while assessing each new native user once", async () => {
		const h = harness({ strategy: "shadow" }); h.user(); h.result = choice(0.1);
		assert.equal((await h.dispatch()).model.id, "mid");
		h.add({ role: "toolResult", toolName: "write", isError: false });
		assert.equal((await h.dispatch("continuation")).model.id, "cheap");
		h.user("harder"); h.result = choice(0.9);
		assert.equal((await h.dispatch()).model.id, "cheap"); const writes = h.writes;
		await h.dispatch(); await h.dispatch("retry"); assert.equal(h.calls.length, 2);
		assert.equal(h.writes, writes); assert.equal(h.state.model, "cheap");
	});
	it("shadow cancellation does not consume a new user", async () => {
		const h = harness({ strategy: "shadow" }); h.user(); h.result = choice(0.1); await h.dispatch();
		h.user("next"); const state = h.state; h.result = { stopReason: "aborted" };
		await assert.rejects(() => h.dispatch(), { name: "AbortError" }); assert.equal(h.state, state);
		h.result = choice(1); await h.dispatch(); assert.equal(h.calls.length, 3); assert.equal(h.state.model, "mid");
	});
});

describe("decision records", () => {
	it("logs numeric metadata, never prompt/tool/error sentinels; unknown price stays unknown", async () => {
		const savedError = console.error; const logs: string[] = [];
		console.error = (...args) => logs.push(args.join(" "));
		try {
			const h = harness({ strategy: "adaptive", debug: true }); h.user("PROMPT_SECRET");
			h.result = { ...choice(0.1), usage: { input: 12, output: 2, cost: { total: 0 }, secret: "USAGE_SECRET" } };
			await h.dispatch();
			h.add({ role: "toolResult", toolName: "write", isError: false, content: "TOOL_SECRET", details: { args: "ARGS_SECRET" } });
			await h.dispatch("continuation"); h.user("NEXT_SECRET");
			h.result = () => { throw Error("ERROR_SECRET"); }; await h.dispatch();
			const records = logs.filter(line => line.startsWith("[pi-jev-router] { ".trimEnd())).map(line => JSON.parse(line.slice("[pi-jev-router] ".length)));
			assert.equal(records.length, 3);
			assert.equal(records[0].decisionReason, "initial"); assert.equal(records[0].classifierStatus, "classified");
			assert.deepEqual(records[0].usage, { tokens: { input: 12, output: 2 }, cost: "unknown" });
			assert.equal(records[1].decisionReason, "initial-write"); assert.equal(records[1].switched, true);
			assert.equal(records[2].decisionReason, "keep-unavailable"); assert.equal(records[2].classifierStatus, "error");
			const allowed = new Set(["strategy", "policyVersion", "requestReason", "stageSeq", "from", "to", "decisionReason", "classifierStatus", "probability", "classifierDurationMs", "switched", "usage"]);
			for (const record of records) for (const key of Object.keys(record)) assert.ok(allowed.has(key), key);
			assert.doesNotMatch(logs.join(""), /PROMPT_SECRET|TOOL_SECRET|ARGS_SECRET|ERROR_SECRET|USAGE_SECRET|NEXT_SECRET/);
		} finally { console.error = savedError; }
	});
});

function historyFixture(patch: any = {}) {
	const h = harness({ strategy: "adaptive", adaptive: { contextMode: "recent-conversation", ...patch } });
	h.user("old"); h.add({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "answer" }] });
	h.user("recent"); h.add({ role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "plan" }, { type: "thinking", thinking: "THINK_SECRET" }, { type: "toolCall", arguments: { text: "ARG_SECRET" } }] });
	h.add({ role: "toolResult", toolName: "read", content: [{ type: "text", text: "FILE_SECRET" }] });
	h.add({ role: "assistant", stopReason: "error", content: [{ type: "text", text: "ERROR_SECRET" }] });
	h.add({ role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "ABORT_SECRET" }] });
	h.user("current"); return h;
}

describe("provenance and history payload T50–T56", () => {
	it("default adaptive payload only sends current projected native user text", async () => {
		const h = harness({ strategy: "adaptive", promptLimit: 4 }); h.user("RAW_SECRET");
		const sourceEntry = h.branch[0];
		h.projection = [
			{ sourceEntry: { type: "compaction", id: "sum" }, messages: [{ role: "user", content: "SUMMARY_SECRET" }] },
			{ sourceEntry, messages: [{ role: "user", content: [{ type: "text", text: "edited" }, { type: "image", data: "IMAGE_SECRET" }] }] },
			...(["custom_message", "message", "bashExecution"].map((type, i) => ({ sourceEntry: { type, id: "extra" + i, message: { role: type === "message" ? "bashExecution" : "user" } }, messages: [{ role: "user", content: "INJECTED_SECRET" }] }))),
		];
		await h.dispatch("user", { messages: [{ role: "user", content: "REQUEST_SECRET" }] });
		assert.deepEqual(h.calls[0][1].state, { current: "edit" });
		assert.match(h.calls[0][1].questions.complexity.instructions, /state.current/);
		assert.doesNotMatch(JSON.stringify(h.state), /RAW_SECRET|edited|INJECTED_SECRET/);
	});
	it("recent-conversation sends chronological complete rounds, successful assistant text only", async () => {
		const h = historyFixture(); await h.dispatch();
		assert.deepEqual(h.calls[0][1].state, { current: "current", recentTurns: [{ user: "old", assistant: ["answer"] }, { user: "recent", assistant: ["plan"] }], historyPartial: true });
		assert.match(h.calls[0][1].questions.complexity.instructions, /state.recentTurns/);
		assert.doesNotMatch(JSON.stringify(h.calls[0][1]), /THINK_SECRET|ARG_SECRET|FILE_SECRET|ERROR_SECRET|ABORT_SECRET|e[1-9]/);
	});
	for (const [patch, expected] of [[{ historyMaxTurns: 1 }, [{ user: "recent", assistant: ["plan"] }]], [{ historyCharLimit: 10 }, [{ user: "recent", assistant: ["plan"] }]], [{ historyCharLimit: 9 }, []]] as const)
		it("drops whole earliest turns within " + JSON.stringify(patch), async () => {
			const h = historyFixture(patch); await h.dispatch(); const input = h.calls[0][1].state;
			assert.deepEqual(input.recentTurns, expected); assert.equal(input.historyPartial, true); assert.equal(input.current, "current");
		});
	it("oversized newest round yields empty history, never fragments or older small rounds", async () => {
		const h = historyFixture({ historyCharLimit: 8 });
		h.branch[0].message.content = "x"; h.branch[1].message.content = "y";
		await h.dispatch();
		assert.deepEqual(h.calls[0][1].state.recentTurns, []);
	});
	it("uses only projection replacements and flags deletions/compaction partial", async () => {
		const h = historyFixture();
		h.branch.push({ type: "context_edit", id: "edit" });
		h.projection = h.branch.slice(2, -1).map(sourceEntry => ({ sourceEntry, messages: sourceEntry.message ? [{ ...sourceEntry.message, content: sourceEntry.message.role === "assistant" ? [{ type: "text", text: "visible" }] : sourceEntry.message.content }] : [] }));
		h.projection.unshift({ sourceEntry: { type: "compaction", id: "compact" }, messages: [{ role: "user", content: "SUMMARY_SECRET" }] });
		await h.dispatch(); const input = h.calls[0][1].state;
		assert.deepEqual(input.recentTurns, [{ user: "recent", assistant: ["visible"] }]); assert.equal(input.historyPartial, true);
		assert.doesNotMatch(JSON.stringify(input), /old|answer|plan|SUMMARY_SECRET/);
	});
	it("classifier disabled sends nothing even when history enabled", async () => {
		const h = harness({ strategy: "adaptive", classifier: null, adaptive: { contextMode: "recent-conversation" } }); h.user();
		await h.dispatch(); assert.equal(h.calls.length, 0);
	});
	it("fixed ignores adaptive context mode and retains prompt payload", async () => {
		const h = harness({ adaptive: { contextMode: "recent-conversation" } }); h.user(); await h.dispatch();
		assert.deepEqual(h.calls[0][1].state, { prompt: "task" });
	});
});

describe("shared slot IDs and late classification", () => {
	it("same standard/complex ID preserves selected slot and permits later complex assessment without a physical switch", async () => {
		const h = await initialized({ models: { ...slots, standard: "strong" } });
		assert.equal(h.state.slot, "standard"); const seq = h.state.stageSeq;
		h.user("complex"); h.result = choice(1); await h.dispatch();
		assert.equal(h.calls.length, 2); assert.equal(h.state.slot, "complex"); assert.equal(h.state.stageSeq, seq); assert.equal(h.state.handoff, "locked");
	});
	it("timeout after initialization keeps model and handles a late success without state changes", async () => {
		const h = await initialized({ adaptive: { decisionTimeoutMs: 2 } });
		h.add({ role: "toolResult", toolName: "write", isError: false }); await h.dispatch("continuation"); h.user("complex");
		let resolve!: (value: any) => void; h.result = () => new Promise(yes => { resolve = yes; });
		assert.equal((await h.dispatch()).model.id, "cheap"); const writes = h.writes; const state = h.state;
		resolve(choice(1)); await new Promise(yes => setImmediate(yes)); assert.equal(h.state, state); assert.equal(h.writes, writes);
	});
	it("cancelled initialization returns no state and can be retried on same user", async () => {
		const h = harness({ strategy: "adaptive" }); h.user(); h.result = { stopReason: "aborted" };
		await assert.rejects(() => h.dispatch(), /cancel/i); assert.equal(h.state, undefined); assert.equal(h.writes, 0);
		h.result = choice(1); await h.dispatch(); assert.equal(h.state.model, "strong"); assert.equal(h.calls.length, 2);
	});
});

describe("configuration and stage invariants", () => {
	for (const patch of [{ models: { ...slots, standard: "cheap" } }, { adaptive: { handoffTools: ["save"] } }, { adaptive: { contextMode: "recent-conversation" } }])
		it("policy change rebuilds locked stage: " + JSON.stringify(patch), async () => {
			const original = await initialized(); const h = harness({ strategy: "adaptive", ...patch }); h.user(); h.state = original.state;
			await h.dispatch(); assert.equal(h.state.stageSeq, 2); assert.equal(h.state.handoff, "locked"); assert.equal(h.state.model, "mid");
			assert.equal(h.calls.length, 0); const writes = h.writes; await h.dispatch("continuation"); assert.equal(h.writes, writes);
		});
	it("config recovery and upgrade in the same route increment stage only once", async () => {
		const original = await initialized(); const h = harness({ strategy: "adaptive", threshold: 0.4 }); h.user(); h.state = original.state;
		const newUser = h.user("complex"); h.result = choice(1); await h.dispatch();
		assert.equal(h.state.model, "strong"); assert.equal(h.state.stageSeq, 2); assert.equal(h.state.stageStartEntryId, newUser.id);
	});
	it("debug/virtual display changes do not change policy identity or persist duplicate state", async () => {
		const original = await initialized(); const h = harness({ strategy: "adaptive", virtual: { name: "renamed", contextWindow: 4000 } }); h.user(); h.state = original.state;
		await h.dispatch(); assert.equal(h.writes, 0); assert.equal(h.state.stageSeq, 1);
	});
	it("writes from current user before the initialization anchor cannot hand off", async () => {
		const h = harness({ strategy: "adaptive" }); h.user(); h.add({ role: "toolResult", toolName: "write", isError: false }); h.result = choice(0.1);
		await h.dispatch(); await h.dispatch("continuation"); assert.equal(h.state.model, "mid"); assert.equal(h.state.stageSeq, 1);
	});
	it("adaptive direct bypasses state and host checks but respects caller abort", async () => {
		const h = harness({ strategy: "adaptive" }); delete h.ctx.sessionManager;
		await assert.rejects(() => h.dispatch("direct", { signal: AbortSignal.abort() }), { name: "AbortError" });
		assert.equal((await h.dispatch("direct")).model.id, "cheap");
		assert.equal(h.calls.length, 0); assert.equal(h.writes, 0);
	});
	it("history counts UTF-16 text and leaves the current budget independent", async () => {
		for (const [limit, count] of [[3, 1], [2, 0]]) {
			const h = harness({ strategy: "adaptive", promptLimit: 2, adaptive: { contextMode: "recent-conversation", historyCharLimit: limit } });
			h.user("🙂"); h.add({ role: "assistant", stopReason: "stop", content: "x" }); h.user("abcd"); await h.dispatch();
			assert.equal(h.calls[0][1].state.recentTurns.length, count); assert.equal(h.calls[0][1].state.current, "ab");
		}
	});
});
