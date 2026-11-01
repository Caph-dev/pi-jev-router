import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import factory, * as router from "../extensions/jev-router.ts";

const saved = process.env.JEV_ROUTER_CONFIG;
const dirs: string[] = [];
afterEach(() => {
	if (saved === undefined) delete process.env.JEV_ROUTER_CONFIG; else process.env.JEV_ROUTER_CONFIG = saved;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const usage = { input: 10, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 15,
	cost: { total: 0.04 }, SECRET_FIELD: "USAGE_SECRET" };
const answer = { stopReason: "stop", answers: { complexity: { type: "choice", probabilities: { complex: 0.1 } } }, usage };
function setup(strategy = "adaptive", patch: any = {}) {
	const dir = mkdtempSync(join(tmpdir(), "jev-usage-")); dirs.push(dir);
	const path = join(dir, "jev-router.json");
	writeFileSync(path, JSON.stringify({ provider: "p", strategy, models: { standard: "mid", complex: "strong", implementation: "cheap" }, ...patch }));
	process.env.JEV_ROUTER_CONFIG = path;
	let definition: any, result: any = answer, serial = 0, state: any;
	const entries: any[] = [], notices: string[] = [], noticeLevels: string[] = [], commands = new Map<string, any>(), events = new Map<string, any>();
	let branch = entries, sessionId = "s1", persistenceFails = false;
	const append = (customType: string, data: any) => { if (persistenceFails) throw Error("PERSISTENCE_SECRET"); const e = { type: "custom", customType, data, id: "c" + ++serial }; entries.push(e); if (branch !== entries) branch.push(e); };
	(factory as any)({ getSettings: () => ({}), registerVirtualModel: (d: any) => { definition = d; }, appendEntry: append,
		registerCommand: (name: string, c: any) => commands.set(name, c), on: (name: string, handler: any) => events.set(name, handler) });
	const manager = { getBranch: () => branch, getEntries: () => entries, getLeafId: () => branch.at(-1)?.id ?? null,
		getSessionId: () => sessionId, buildSessionProjection: () => ({ entries: branch.map(sourceEntry => ({ sourceEntry, messages: sourceEntry.message ? [sourceEntry.message] : [] })) }) };
	let count = 0;
	const ctx: any = { sessionManager: manager, hasUI: true, ui: { notify: (text: string, level?: string) => { notices.push(text); noticeLevels.push(level ?? "info"); } }, modelRegistry: {
		find: (provider: string, id: string) => provider === "p" ? { id, provider, contextWindow: 100, maxTokens: 20 } : undefined,
		findOfType: () => ({ provider: "typesafe", id: "jev-latest", cost: { input: 0 } }),
		classify: (...args: any[]) => { count++; return typeof result === "function" ? result(...args) : Promise.resolve(result); },
	} };
	return { entries, manager, ctx, commands, notices, noticeLevels, append, events,
		set persistenceFails(value: boolean) { persistenceFails = value; },
		get count() { return count; }, get state() { return state; }, set state(v: any) { state = v; },
		get result() { return result; }, set result(v: any) { result = v; },
		user(text = "USER_SECRET") { const e = { type: "message", id: "u" + ++serial, message: { role: "user", content: text } }; entries.push(e); if (branch !== entries) branch.push(e); return e; },
		selectBranch(value: any[]) { branch = value; }, switchSession() { sessionId = "s2"; branch = []; },
		summary(scope = "branch") { return (router as any).summarizeClassifierUsage(manager, { provider: "jev", id: "auto" }, scope); },
		async dispatch(reason = "user", extra: any = {}) { const r = await definition.route({ reason, state, messages: branch.filter(e => e.message).map(e => e.message), thinkingLevel: "low", ...extra }, ctx); if (r.state !== undefined) state = r.state; return r; },
	};
}

describe("decision/outcome diagnostics", () => {
	it("records correlated sanitized outcomes separately from classifier usage", async () => {
		const h = setup("adaptive", { diagnostics: { record: true } }); h.user(); await h.dispatch();
		const decision = h.entries.find(e => e.customType === "pi-jev-router.decision")?.data; assert.ok(decision?.decisionId);
		assert.equal(decision.to.id, "mid"); assert.equal(decision.classifierStatus, "classified");
		await h.events.get("message_end")({ message: { role: "assistant", provider: "p", model: "mid", stopReason: "error", thinkingLevel: "low",
			errorMessage: "SERVICE_SECRET rate limit 429", content: "RESPONSE_SECRET", usage } }, h.ctx);
		const outcome = h.entries.find(e => e.customType === "pi-jev-router.outcome")?.data;
		assert.equal(outcome.decisionId, decision.decisionId); assert.equal(outcome.failureCategory, "rate-limit"); assert.equal(outcome.succeeded, false);
		assert.equal(h.summary().calls, 1);
		assert.doesNotMatch(JSON.stringify(h.entries.filter(e => e.type === "custom")), /USER_SECRET|SERVICE_SECRET|USAGE_SECRET|RESPONSE_SECRET/);
	});
	for (const boundary of ["session_before_switch", "session_tree", "agent_end"]) it("clears pending outcome on " + boundary, async () => {
		const h = setup("adaptive", { diagnostics: { record: true } }); h.user(); await h.dispatch();
		h.events.get(boundary)();
		h.events.get("message_end")({ message: { role: "assistant", provider: "p", model: "mid", stopReason: "stop" } }, h.ctx);
		assert.equal(h.entries.filter(e => e.customType === "pi-jev-router.outcome").length, 0);
	});
	it("does not attach outcomes to a different session or ancestor branch", async () => {
		for (const change of ["session", "branch"]) {
			const h = setup("adaptive", { diagnostics: { record: true } }); h.user(); const ancestor = [...h.entries]; await h.dispatch();
			if (change === "session") h.switchSession(); else h.selectBranch(ancestor);
			h.events.get("message_end")({ message: { role: "assistant", provider: "p", model: "mid", stopReason: "stop" } }, h.ctx);
			assert.equal(h.entries.filter(e => e.customType === "pi-jev-router.outcome").length, 0);
		}
	});
	it("record persists an unapplied upgrade proposal", async () => {
		const h = setup("record", { diagnostics: { record: true } }); h.user(); await h.dispatch();
		h.user("next"); h.result = { ...answer, answers: { complexity: { type: "choice", probabilities: { complex: 1 } } } };
		assert.equal((await h.dispatch()).model.id, "mid");
		const decision = h.entries.findLast(e => e.customType === "pi-jev-router.decision").data;
		assert.deepEqual(decision.record, { proposedModel: { provider: "p", id: "strong" }, applied: false, available: true });
	});
});

describe("persistent classifier usage", () => {
	for (const strategy of ["fixed", "adaptive"]) it(strategy + " persists usage without debug and avoids retry/continuation duplication", async () => {
		const h = setup(strategy); h.user(); await h.dispatch();
		assert.equal(h.summary().calls, 1); assert.equal(h.summary().tokens.totalTokens, 15);
		assert.equal(h.summary().cost, "unknown"); assert.equal(h.summary().unknownCostCalls, 1);
		await h.dispatch("continuation"); await h.dispatch("retry");
		assert.equal(h.count, 1); assert.equal(h.summary().calls, 1);
		assert.doesNotMatch(JSON.stringify(h.entries.filter(e => e.type === "custom")), /USER_SECRET|USAGE_SECRET|SECRET_FIELD/);
		assert.equal(h.entries.filter(e => e.type === "custom").length, 2, "pending and final snapshots share one call ID");
	});
	it("deduplicates snapshots and reconstructs usage after reopen/fork without counting other branches", async () => {
		const h = setup(); h.user(); await h.dispatch();
		const first = [...h.entries]; h.user("next"); await h.dispatch();
		assert.equal(h.summary().calls, 2); h.selectBranch(first);
		assert.equal(h.summary().calls, 1); assert.equal(h.summary("session").calls, 2);
		const final = first.at(-1); h.append(final.customType, final.data);
		assert.equal(h.summary().calls, 1); assert.equal(h.summary().tokens.input, 10);
		assert.equal(h.summary("session").calls, 2);
	});
	it("exposes the branch/session query as a subcommand without invoking a model", async () => {
		const h = setup(); h.user(); await h.dispatch();
		await h.commands.get("jev-router").handler("usage --json", h.ctx);
		assert.deepEqual(JSON.parse(h.notices.at(-1)!), h.summary()); assert.equal(h.count, 1);
		await h.commands.get("jev-router").handler("usage --session --json", h.ctx);
		assert.deepEqual(JSON.parse(h.notices.at(-1)!), h.summary("session"));
	});
	it("retains unknown usage on errors and counts actual reattempts as new calls", async () => {
		const h = setup(); h.user(); h.result = () => { throw Error("SERVICE_SECRET"); };
		await h.dispatch(); assert.equal(h.summary().missingUsageCalls, 1);
		h.state = undefined; await h.dispatch(); assert.equal(h.count, 2); assert.equal(h.summary().calls, 2);
		assert.doesNotMatch(JSON.stringify(h.entries), /SERVICE_SECRET/);
	});
	it("bounds timeout and never appends a late result to the ledger", async () => {
		const h = setup("adaptive", { adaptive: { decisionTimeoutMs: 5 } }); h.user();
		let finish: any; h.result = () => new Promise(resolve => { finish = resolve; });
		await h.dispatch(); const snapshot = JSON.stringify(h.entries);
		assert.equal(h.summary().missingUsageCalls, 1); finish(answer); await new Promise(resolve => setImmediate(resolve));
		assert.equal(JSON.stringify(h.entries), snapshot);
	});
	it("records cancellation without consuming routing state or inventing usage", async () => {
		const h = setup(); h.user(); const controller = new AbortController();
		h.result = () => { controller.abort(); return new Promise(() => {}); };
		await assert.rejects(() => h.dispatch("user", { signal: controller.signal }), { name: "AbortError" });
		assert.equal(h.state, undefined); assert.equal(h.summary().calls, 1); assert.equal(h.summary().missingUsageCalls, 1);
	});
	it("does not write a completion into a switched session", async () => {
		const h = setup(); h.user(); h.result = () => { h.switchSession(); return answer; };
		await assert.rejects(() => h.dispatch(), { name: "AbortError" });
		assert.equal(h.state, undefined); assert.equal(h.entries.length, 2); assert.equal(h.summary("session").pendingCalls, 1);
	});
	it("persistence failures cannot change routing or expose raw errors", async () => {
		const h = setup("adaptive", { diagnostics: { record: true } }); h.user(); h.persistenceFails = true;
		h.result = { ...answer, answers: { complexity: { type: "choice", probabilities: { complex: 1 } } } };
		const savedError = console.error, logs: string[] = []; console.error = (...args) => logs.push(args.join(" "));
		try {
			assert.equal((await h.dispatch()).model.id, "strong"); assert.equal(h.count, 1);
			assert.doesNotMatch(logs.join(""), /PERSISTENCE_SECRET/);
		} finally { console.error = savedError; }
	});
	it("does not record disabled classifiers or direct requests", async () => {
		const h = setup("adaptive", { classifier: null }); h.user(); await h.dispatch(); await h.dispatch("direct");
		assert.equal(h.summary().calls, 0);
	});
	it("keeps known positive pricing while rejecting unsafe usage fields", async () => {
		const h = setup(); h.ctx.modelRegistry.findOfType = () => ({ provider: "typesafe", id: "jev-latest", cost: { input: 1 } });
		h.user(); await h.dispatch(); assert.equal(h.summary().cost, 0.04); assert.equal(h.summary().knownCost, 0.04);
	});
});

describe("jev-router command surface", () => {
	const saved = { config: process.env.JEV_ROUTER_CONFIG, debug: process.env.JEV_ROUTER_DEBUG, agent: process.env.PI_CODING_AGENT_DIR };
	afterEach(() => {
		for (const [key, value] of [["JEV_ROUTER_CONFIG", saved.config], ["JEV_ROUTER_DEBUG", saved.debug], ["PI_CODING_AGENT_DIR", saved.agent]] as const) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	});
	const run = (h: any, args: string) => h.commands.get("jev-router").handler(args, h.ctx);

	it("registers one namespaced command and drops the old name", () => {
		const h = setup();
		assert.deepEqual([...h.commands.keys()], ["jev-router"]);
		assert.equal(h.commands.has("jev-usage"), false);
	});
	it("answers bare arguments with help at info level", async () => {
		const h = setup();
		for (const args of ["", "   ", "help", "--help", "-h"]) {
			await run(h, args);
			assert.equal(h.noticeLevels.at(-1), "info");
			assert.match(h.notices.at(-1)!, /^Usage: \/jev-router <command>/);
			assert.match(h.notices.at(-1)!, /\n  status +Configured strategy/);
		}
		assert.equal(h.entries.length, 0); assert.equal(h.count, 0);
	});
	it("reports the startup configuration without calling a model or writing entries", async () => {
		const h = setup("adaptive", { diagnostics: { record: true } });
		await run(h, "status");
		assert.equal(h.noticeLevels.at(-1), "info");
		const text = h.notices.at(-1)!;
		assert.match(text, /^Config view for jev\/auto, read at startup/);
		assert.match(text, /\nstrategy: adaptive\n/);
		assert.match(text, /\nplanning: p\/strong \(complex\), p\/mid \(standard\)\n/);
		assert.match(text, /\nimplementation: p\/cheap\n/);
		assert.match(text, /\ndirect: p\/cheap \(follows models\.implementation\)\n/);
		assert.match(text, /\nclassifier: typesafe\/jev-latest \(configured; availability is decided per request\)\n/);
		assert.match(text, /\nthreshold: 0\.5; prompt limit: 16000 chars\n/);
		assert.match(text, /\ndiagnostics: recorded as session entries; debug: off\n/);
		assert.ok(text.includes("\nconfig: " + process.env.JEV_ROUTER_CONFIG), "status names the config file it read");
		assert.equal(h.count, 0); assert.equal(h.entries.length, 0);
	});
	it("reports an explicit direct model and its source", async () => {
		const h = setup("fixed", { models: { standard: "mid", complex: "strong", implementation: "cheap", direct: "fast" } });
		await run(h, "status");
		assert.match(h.notices.at(-1)!, /\ndirect: p\/fast \(models\.direct\)\n/);
	});
	it("does not claim a planning-only route when only the direct model is set", async () => {
		const h = setup("fixed", { models: { standard: "mid", complex: "strong", implementation: null, direct: "fast" } });
		await run(h, "status");
		const text = h.notices.at(-1)!;
		assert.match(text, /\nimplementation: none \(no implementation model configured\)\n/);
		assert.match(text, /\ndirect: p\/fast \(models\.direct\)\n/);
		assert.doesNotMatch(text, /every request/);
	});
	it("reports a disabled classifier and the environment-only debug override", async () => {
		process.env.JEV_ROUTER_DEBUG = "1";
		const h = setup("adaptive", { classifier: null });
		await run(h, "status");
		const text = h.notices.at(-1)!;
		assert.match(text, /\nclassifier: disabled \(planning uses the standard model\)\n/);
		assert.match(text, /debug: on \(\$JEV_ROUTER_DEBUG\)/);
	});
	it("reports built-in defaults when no config file is read", async () => {
		const dir = mkdtempSync(join(tmpdir(), "jev-status-defaults-")); dirs.push(dir);
		delete process.env.JEV_ROUTER_CONFIG; delete process.env.JEV_ROUTER_DEBUG; process.env.PI_CODING_AGENT_DIR = dir;
		const commands = new Map<string, any>(); const notices: string[] = [];
		(factory as any)({ getSettings: () => ({}), registerVirtualModel: () => {}, appendEntry: () => {},
			registerCommand: (name: string, c: any) => commands.set(name, c), on: () => {} });
		await commands.get("jev-router").handler("status", { hasUI: true, ui: { notify: (text: string) => notices.push(text) } });
		assert.match(notices.at(-1)!, /\nconfig: built-in defaults \(no file read; expected /);
		assert.match(notices.at(-1)!, /\nstrategy: adaptive\n/);
		assert.match(notices.at(-1)!, /\nplanning: openai-codex\/gpt-6\.1-sol \(complex\), openai-codex\/gpt-6\.1-terra \(standard\)\n/);
	});
	it("rejects extra or unknown arguments without calling a model", async () => {
		const h = setup();
		await run(h, "status --session");
		assert.equal(h.notices.at(-1), "Usage: /jev-router status"); assert.equal(h.noticeLevels.at(-1), "error");
		await run(h, "usage --deep");
		assert.equal(h.notices.at(-1), "Usage: /jev-router usage [--session] [--json]"); assert.equal(h.noticeLevels.at(-1), "error");
		await run(h, "bogus");
		assert.equal(h.noticeLevels.at(-1), "error");
		assert.match(h.notices.at(-1)!, /^Unknown command "bogus"\.\nUsage: \/jev-router <command>/);
		assert.equal(h.count, 0); assert.equal(h.entries.length, 0);
	});
	it("writes info to stdout and errors to stderr when the host has no UI", async () => {
		const h = setup();
		const out: string[] = [], err: string[] = []; const savedLog = console.log, savedError = console.error;
		console.log = (...parts: unknown[]) => void out.push(parts.join(" ")); console.error = (...parts: unknown[]) => void err.push(parts.join(" "));
		const headless = { ...h.ctx, hasUI: false, ui: { notify: () => { throw Error("NO_UI"); } } };
		try {
			await h.commands.get("jev-router").handler("usage", headless);
			await h.commands.get("jev-router").handler("" , headless);
			await h.commands.get("jev-router").handler("status", headless);
			await h.commands.get("jev-router").handler("bogus", headless);
			await h.commands.get("jev-router").handler("status --session", headless);
		} finally { console.log = savedLog; console.error = savedError; }
		assert.equal(out.length, 3); assert.equal(err.length, 2);
		assert.match(out[0], /^Classifier usage \(branch\): 0 calls/);
		assert.match(out[1], /^Usage: \/jev-router <command>/);
		assert.match(out[2], /^Config view for jev\/auto/);
		assert.match(err[0], /^Unknown command "bogus"/);
		assert.equal(err[1], "Usage: /jev-router status");
	});
});

describe("classifier adapter metadata", () => {
	const records = (h: any) => h.entries.filter((entry: any) => entry.customType === "pi-jev-router.classifier-usage").map((entry: any) => entry.data);
	it("records the adapter per call and summarizes distinct adapters", async () => {
		const h = setup("adaptive", { classifier: { provider: "llama.cpp", id: "local" } });
		h.ctx.modelRegistry.findOfType = () => ({ provider: "llama.cpp", id: "local", api: "llama-cpp-classify", cost: { input: 0 } });
		h.user(); await h.dispatch();
		assert.deepEqual(records(h).map((record: any) => [record.status, record.api]),
			[["pending", "llama-cpp-classify"], ["stop", "llama-cpp-classify"]]);
		assert.deepEqual(h.summary().apis, ["llama-cpp-classify"]);
	});
	it("prefers the adapter the result reports and does not double-count the pending one", async () => {
		const h = setup(); h.user();
		h.ctx.modelRegistry.findOfType = () => ({ provider: "typesafe", id: "jev-latest", api: "typesafe-system-one", cost: { input: 1 } });
		h.result = { ...answer, api: "openai-decisions" };
		await h.dispatch();
		assert.deepEqual(records(h).map((record: any) => record.api), ["typesafe-system-one", "openai-decisions"]);
		assert.deepEqual(h.summary().apis, ["openai-decisions"]);
	});
	it("tolerates records written before the adapter field existed", async () => {
		const h = setup();
		h.append("pi-jev-router.classifier-usage", { schemaVersion: 1, callId: "old", virtual: { provider: "jev", id: "auto" },
			provider: "typesafe", model: "jev-latest", status: "stop", usage: { tokens: { input: 1 }, cost: "unknown" } });
		const summary = h.summary();
		assert.equal(summary.calls, 1); assert.equal(summary.tokens.input, 1); assert.deepEqual(summary.apis, []);
	});
});
