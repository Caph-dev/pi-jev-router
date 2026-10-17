/** Opt-in real SDK/LLM smoke. Never discovered by npm test; no personal resources loaded. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import router, { summarizeClassifierUsage } from "../extensions/jev-router.ts";

assert.equal(process.env.JEV_ROUTER_LIVE, "1", "Set JEV_ROUTER_LIVE=1 to authorize billable calls");
assert.ok(process.env.PI_ROUTER_HOST_MODULE, "Set PI_ROUTER_HOST_MODULE to the installed pi public entry");
const host = await import(pathToFileURL(resolve(process.env.PI_ROUTER_HOST_MODULE)).href);
const scenario = process.argv[2] ?? "core";
assert.ok(["core", "fixed", "cancel", "retry"].includes(scenario));
const root = mkdtempSync(join(tmpdir(), "jev-live-"));
const provider = "codex-sub2api", sol = "gpt-6.1-sol", luna = "gpt-6-luna";
const configured = JSON.parse(readFileSync(join(homedir(), ".pi/agent/models.json"), "utf8")).providers[provider];
assert.ok(configured, "Authorized provider must exist");
const providerConfig = { ...configured, models: configured.models.filter((m: any) => [sol, luna].includes(m.id)) };
assert.equal(providerConfig.models.length, 2);
const evidence: any = { scriptSha256: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"),
	config: { classifierBudgetMs: 3000, handoffPolicy: "guarded", handoffThreshold: 0.2, maxHandoffContextTokens: 50000, history: "last-user-only", thinking: "low" }, scenario, startedAt: new Date().toISOString(), node: process.version,
	hostVersion: JSON.parse(readFileSync(join(dirname(process.env.PI_ROUTER_HOST_MODULE), "../package.json"), "utf8")).version,
	provider, models: { standard: sol, complex: sol, implementation: luna, direct: luna }, checks: [], runs: [] };
let active: any;
let httpCount = 0, chatCount = 0;
const savedConfig = process.env.JEV_ROUTER_CONFIG;
const savedDebug = process.env.JEV_ROUTER_DEBUG;
const nativeFetch = globalThis.fetch;
// Observe actual HTTP starts. Faults are explicitly injected, never reported as natural API failures.
globalThis.fetch = (async (input: any, init: any) => {
	assert.ok(++httpCount <= 64, "HTTP request budget exceeded");
	const h = active;
	if (h?.classifying) {
		h.events.push({ type: "classifier-http-start" });
		const request = nativeFetch(input, init);
		if (h.cancelOnClassifier && !h.abortRequested) {
			h.abortRequested = true;
			h.abortTimer = setTimeout(() => {
				h.events.push({ type: "caller-abort" });
				h.abortPromise = h.session.abort();
			}, 25);
		}
		return request;
	}
	if (h?.faultArmed) {
		h.events.push({ type: "injected-http-503" });
		return new Response(JSON.stringify({ error: { message: "503 temporarily unavailable: injected live smoke fault", type: "server_error" } }),
			{ status: 503, headers: { "content-type": "application/json" } });
	}
	return nativeFetch(input, init);
}) as typeof fetch;
let deadlineExceeded = false;
const wallTimer = setTimeout(() => {
	deadlineExceeded = true; active?.session?.abortCompaction(); void active?.session?.abort();
}, 600_000);
async function bounded(h: any, operation: () => Promise<any>) {
	assert.equal(deadlineExceeded, false, "Overall live-test deadline exceeded");
	let expired = false;
	const timer = setTimeout(() => { expired = true; h.session.abortCompaction(); void h.session.abort(); }, 90000);
	try { const result = await operation(); assert.equal(expired || deadlineExceeded, false, "Live operation timed out"); return result; }
	finally { clearTimeout(timer); }
}

function stateOf(manager: any) {
	return manager.getBranch().findLast((e: any) => e.type === "custom" && e.customType === "pi.virtual-model-state" && e.data?.provider === "jev" && e.data?.modelId === "auto")?.data.state;
}
function publicState(state: any) {
	if (!state) return null;
	return Object.fromEntries(["phase", "model", "slot", "handoff", "stageSeq", "lastEvaluatedUserEntryId", "stageStartEntryId"].map(k => [k, state[k]]));
}
function check(name: string) { evidence.checks.push(name); console.log("PASS " + name); }
function assistants(manager: any) {
	return manager.getEntries().filter((e: any) => e.type === "message" && e.message.role === "assistant").map((e: any) => e.message);
}
function persist() { writeFileSync(join(root, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 }); }
async function open(label: string, options: any = {}) {
	assert.equal(deadlineExceeded, false, "Overall live-test deadline exceeded");
	const dir = join(root, label); mkdirSync(dir);
	const agentDir = join(dir, "agent"); mkdirSync(agentDir);
	const cwd = options.cwd ?? join(dir, "workspace"); mkdirSync(cwd, { recursive: true });
	const config = join(dir, "jev-router.json");
	writeFileSync(config, JSON.stringify({ ...(options.strategy === "fixed" ? {} : { strategy: "adaptive" }), provider,
		models: { complex: sol, standard: sol, implementation: luna, direct: luna },
		classifier: options.classifier === false ? null : { provider: "typesafe", id: "jev-latest" },
		debug: false }), { mode: 0o600 });
	process.env.JEV_ROUTER_CONFIG = config; delete process.env.JEV_ROUTER_DEBUG;
	const runtime = await host.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
		modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
	runtime.registerProvider(provider, providerConfig);
	if (process.env.TYPESAFE_API_KEY) await runtime.setRuntimeApiKey("typesafe", process.env.TYPESAFE_API_KEY);
	assert.ok(runtime.hasConfiguredAuth(provider), "Authorized provider authentication unavailable");
	const h: any = { label, dir, cwd, runtime, routes: [], classifiers: [], events: [], dispatches: [], classifying: 0, pending: new Set() };
	active = h;
	const manager = options.sessionFile ? host.SessionManager.open(options.sessionFile, join(dir, "sessions")) : host.SessionManager.create(cwd, join(dir, "sessions"));
	h.manager = manager;
	const nativeClassify = runtime.classify.bind(runtime);
	runtime.classify = async (...args: any[]) => {
		const pendingUsage = summarizeClassifierUsage(manager);
		assert.equal(pendingUsage.pendingCalls, 1, "Classification attempt must be durable before HTTP");
		const disk = host.SessionManager.open(manager.getSessionFile(), join(dir, "usage-disk"));
		assert.deepEqual(summarizeClassifierUsage(disk), pendingUsage);
		h.classifying++;
		const started = performance.now();
		const pending = nativeClassify(...args); h.pending.add(pending);
		try {
			const result = await pending;
			h.classifiers.push({ stopReason: result.stopReason, probability: result.answers?.complexity?.probabilities?.complex,
				durationMs: Math.round(performance.now() - started), usage: result.usage });
			h.events.push({ type: "classifier-end", stopReason: result.stopReason });
			return result;
		} finally { h.classifying--; h.pending.delete(pending); }
	};
	const nativeResolve = runtime.resolveModel.bind(runtime);
	runtime.resolveModel = async (model: any, messages: any, opts: any) => {
		const result = await nativeResolve(model, messages, opts);
		h.routes.push({ reason: opts.reason, model: result.model.id, thinkingLevel: result.thinkingLevel,
			failedModel: opts.failed?.model, failedThinkingLevel: opts.failed?.thinkingLevel, state: publicState(result.state ?? opts.state) });
		return result;
	};
	const nativeStream = runtime.streamSimple.bind(runtime);
	runtime.streamSimple = (model: any, context: any, opts: any) => {
		assert.ok(++chatCount <= 32, "Chat request budget exceeded");
		assert.equal(model.provider, provider); assert.ok([sol, luna].includes(model.id));
		const state = publicState(stateOf(manager)), route = h.routes.at(-1);
		const disk = host.SessionManager.open(manager.getSessionFile(), join(dir, "disk-check"));
		const stateOnDisk = publicState(stateOf(disk));
		assert.deepEqual(stateOnDisk, state, "Disk state must match memory before dispatch");
		if (route?.reason !== "direct") {
			assert.deepEqual(state, route?.state, "Persisted state must match resolved route before dispatch");
			assert.equal(state?.model, model.id);
		}
		h.dispatches.push({ model: model.id, stateBeforeDispatch: state, stateOnDiskBeforeDispatch: stateOnDisk });
		return nativeStream(model, context, { ...opts, maxTokens: 2048 });
	};
	const settings = host.SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 2048, keepRecentTokens: 1 },
		cacheWarming: "off", transport: "sse", retry: { enabled: true, maxRetries: 1, baseDelayMs: 10, provider: { maxRetries: 0, timeoutMs: 90000 } },
		codemode: { mode: "only" }, modelThinkingLevels: { [provider + "/" + sol]: "low", [provider + "/" + luna]: "low" } });
	const loader = new host.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [router, host.createCodemodeExtension({ mode: "only" })],
		systemPrompt: "You are running an isolated router smoke test. Only write files named by the user in this workspace. Do not browse or run shell commands. Use codemode for all tool calls. Keep answers under 80 words. After one successful requested write, stop calling tools and give a brief confirmation." });
	await loader.reload();
	assert.equal(loader.getExtensions().errors.length, 0, "Extension loading failed");
	const selected = runtime.getModel("jev", "auto");
	// Virtual registration is bound during session creation; physical model is only an initial placeholder.
	const { session } = await host.createAgentSession({ cwd, agentDir, modelRuntime: runtime,
		model: selected ?? runtime.getModel(provider, sol), resourceLoader: loader, settingsManager: settings,
		sessionManager: manager, thinkingLevel: "low", tools: ["codemode", "write", "read"] });
	h.session = session;
	await session.bindExtensions({});
	const virtual = runtime.getModel("jev", "auto"); assert.ok(virtual);
	if (session.model.provider !== "jev") await session.setModel(virtual);
	assert.equal(session.model.provider, "jev");
	assert.equal(loader.getSkills().skills.length, 0); assert.equal(loader.getAgentsFiles().agentsFiles.length, 0);
	session.subscribe((event: any) => {
		if (event.type === "auto_retry_start") { h.faultArmed = false; h.events.push({ type: event.type, attempt: event.attempt }); }
		if (event.type === "message_end" && event.message.role === "assistant") h.events.push({ type: "assistant-end", model: event.message.model, thinkingLevel: event.message.thinkingLevel, stopReason: event.message.stopReason });
	});
	h.close = () => { clearTimeout(h.abortTimer); session.dispose(); evidence.runs.push({ label, sessionFile: manager.getSessionFile(), routes: h.routes,
		classifierUsage: summarizeClassifierUsage(manager), sessionClassifierUsage: summarizeClassifierUsage(manager, undefined, "session"),
		classificationRecords: manager.getBranch().filter((e: any) => e.type === "custom" && e.customType === "pi-jev-router.classifier-usage").map((e: any) => e.data),
		classifiers: h.classifiers, dispatches: h.dispatches, events: h.events, finalState: publicState(stateOf(manager)), stats: session.getSessionStats() }); persist(); };
	return h;
}
async function prompt(h: any, text: string) {
	console.log("RUN " + h.label); active = h;
	const timer = setTimeout(() => { void h.session.abort(); }, 90000);
	try {
		await h.session.prompt(text); await h.session.waitForIdle();
		const last = assistants(h.manager).at(-1);
		assert.ok(last && last.stopReason !== "error" && last.stopReason !== "aborted", "Real assistant did not succeed");
	} finally { clearTimeout(timer); }
}
async function continuation(h: any) {
	active = h;
	const userCount = h.manager.getBranch().filter((e: any) => e.message?.role === "user").length;
	const classifiers = h.classifiers.length, previousState = publicState(stateOf(h.manager));
	await bounded(h, async () => {
		await h.session.sendCustomMessage({ customType: "jev-live-probe", content: "Reply exactly OK. Do not use tools.", display: false }, { triggerTurn: true });
		await h.session.waitForIdle();
	});
	assert.equal(h.manager.getBranch().filter((e: any) => e.message?.role === "user").length, userCount);
	assert.equal(h.classifiers.length, classifiers); assert.equal(h.routes.at(-1)?.reason, "continuation");
	assert.deepEqual(publicState(stateOf(h.manager)), previousState);
	const last = assistants(h.manager).at(-1);
	assert.equal(last?.stopReason, "stop", "Continuation must receive a successful real response");
}
async function queryUsage(h: any, scope = "branch") {
	const before = { httpCount, chatCount, leaf: h.manager.getLeafId() }, lines: string[] = [];
	const log = console.log;
	console.log = (...parts: any[]) => { lines.push(parts.join(" ")); };
	try { await bounded(h, () => h.session.prompt("/jev-usage --json" + (scope === "session" ? " --session" : ""))); }
	finally { console.log = log; }
	assert.deepEqual({ httpCount, chatCount, leaf: h.manager.getLeafId() }, before, "Usage query must not invoke a model or mutate the session");
	assert.equal(lines.length, 1, "Command must return one structured result");
	const summary = JSON.parse(lines[0]);
	assert.deepEqual(summary, summarizeClassifierUsage(h.manager, undefined, scope as "branch" | "session"));
	(evidence.commandQueries ??= []).push({ label: h.label, summary });
	return summary;
}
async function fixed() {
	const h = await open("fixed", { strategy: "fixed" });
	await prompt(h, 'Use codemode to call tools.write({path:"fixed-marker.txt", content:"hello"}) exactly once. This is a trivial single-file text write, no design needed. Then answer DONE without further tools.');
	assert.equal(readFileSync(join(h.cwd, "fixed-marker.txt"), "utf8"), "hello");
	assert.equal(h.classifiers.length, 1); assert.equal(h.routes[0].model, sol);
	assert.equal(h.classifiers[0].stopReason, "stop"); assert.ok(h.classifiers[0].probability < 0.5);
	assert.ok(h.manager.getBranch().some((e: any) => e.message?.toolName === "codemode" && e.message.nestedCalls?.calls.some((c: any) => c.name === "write" && c.status === "ok")));
	assert.ok(h.routes.some((r: any) => r.reason === "continuation" && r.model === luna));
	assert.equal(stateOf(h.manager).phase, "implementation"); assert.equal(stateOf(h.manager).model, luna);
	assert.equal(stateOf(h.manager).handoff, "locked"); assert.equal(stateOf(h.manager).provider, provider);
	const summary = await queryUsage(h); assert.equal(summary.calls, 1); assert.equal(summary.pendingCalls, 0);
	assert.equal(summary.tokens.input, h.classifiers[0].usage.input); assert.equal(summary.tokens.output, h.classifiers[0].usage.output);
	check("default fixed recognizes real Codemode nested write, hands sol to luna and exposes durable usage");
	await prompt(h, "Explain distributed lease fencing under partitions in two sentences. Do not use tools.");
	assert.equal(h.routes.at(-1).model, luna); assert.equal(h.classifiers.length, 1);
	assert.deepEqual(await queryUsage(h), summary);
	const file = h.manager.getSessionFile(), cwd = h.cwd; h.close();
	const reopened = await open("fixed-reopen", { strategy: "fixed", sessionFile: file, cwd });
	await continuation(reopened); assert.equal(reopened.routes.at(-1).model, luna);
	assert.equal(reopened.classifiers.length, 0); assert.deepEqual(await queryUsage(reopened), summary); reopened.close();
	check("fixed later user and reopened continuation keep luna without reclassification or duplicate ledger usage");
}
async function core() {
	const h = await open("initial");
	await prompt(h, 'Use codemode to call tools.write({path:"marker.txt", content:"hello"}) exactly once. This is a trivial single-file text write, no design or reasoning needed. Then answer DONE without further tools.');
	assert.equal(readFileSync(join(h.cwd, "marker.txt"), "utf8"), "hello");
	assert.ok(h.classifiers[0]?.stopReason === "stop" && h.classifiers[0].probability <= 0.2, "Guarded handoff path not covered: classifier probability exceeds 0.2");
	assert.equal(h.routes[0].state.slot, "standard"); assert.equal(h.routes[0].model, sol);
	assert.ok(h.manager.getBranch().some((e: any) => e.message?.role === "toolResult" && e.message.toolName === "codemode" && e.message.nestedCalls?.calls.some((c: any) => c.name === "write" && c.status === "ok")), "Missing real nested write evidence");
	assert.ok(h.routes.some((r: any) => r.reason === "continuation" && r.model === luna));
	assert.equal(stateOf(h.manager).stageSeq, 2); assert.equal(stateOf(h.manager).slot, "implementation");
	for (const d of h.dispatches) assert.ok(d.stateBeforeDispatch, "State must be persisted before chat dispatch");
	const stats = h.session.getSessionStats();
	const sum = assistants(h.manager).reduce((s: any, m: any) => { for (const k of ["input", "output", "cacheRead", "cacheWrite"]) s[k] += m.usage[k] ?? 0; return s; }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	const classifierUsage = h.classifiers[0].usage;
	const delta = { input: stats.tokens.input - sum.input, output: stats.tokens.output - sum.output };
	const excluded = delta.input === 0 && delta.output === 0;
	const includedOnce = delta.input === classifierUsage.input && delta.output === classifierUsage.output;
	assert.ok(excluded || includedOnce, "Classify accounting has an unexplained delta");
	evidence.accounting = { assistantTokens: sum, sessionTokens: stats.tokens, externalClassifierUsage: classifierUsage,
		delta, directClassifierIncluded: !excluded, note: excluded ? "Session totals equal assistant totals; direct classifier is excluded." : "Classifier usage included once." };
	const initialUsage = await queryUsage(h); assert.equal(initialUsage.calls, 1);
	assert.equal(initialUsage.tokens.input, h.classifiers[0].usage.input); assert.equal(initialUsage.tokens.output, h.classifiers[0].usage.output);
	evidence.accounting.persistedClassifierUsage = initialUsage;
	const cheapLeaf = h.manager.getLeafId(), sessionFile = h.manager.getSessionFile(), cwd = h.cwd;
	check("real Codemode nested write hands sol planning to luna; state saved before dispatch"); h.close();
	const resumed = await open("resume", { sessionFile, cwd });
	assert.equal(stateOf(resumed.manager).slot, "implementation");
	await continuation(resumed);
	assert.equal(resumed.routes.at(-1).model, luna); assert.equal(resumed.routes.at(-1).reason, "continuation");
	assert.equal(resumed.classifiers.length, 0); assert.equal(stateOf(resumed.manager).stageSeq, 2);
	check("fresh runtime resumes persisted implementation; same user continuation does not classify");
	await prompt(resumed, 'Design a linearizable multi-region distributed job scheduler: prove lease-fencing safety under partitions, define crash recovery and idempotency, ensure priority aging prevents starvation, analyze cross-region consistency and throughput tradeoffs, and describe model-based concurrency testing. Reason through interacting failure cases. Deliver a concise design artifact by calling codemode tools.write once with path "design.txt" and your actual design (at most 200 words). Do not implement or run commands. Then confirm briefly.');
	assert.ok(resumed.classifiers.at(-1)?.stopReason === "stop" && resumed.classifiers.at(-1).probability >= 0.5, "Complex upgrade scenario not covered by classifier");
	const upgraded = stateOf(resumed.manager);
	assert.equal(upgraded.slot, "complex"); assert.equal(upgraded.phase, "planning"); assert.equal(upgraded.handoff, "locked"); assert.equal(upgraded.stageSeq, 3);
	assert.ok(readFileSync(join(cwd, "design.txt"), "utf8").length > 0);
	const upgradeIndex = resumed.routes.findIndex((r: any) => r.state?.slot === "complex");
	assert.ok(upgradeIndex >= 0); assert.ok(resumed.routes.slice(upgradeIndex).every((r: any) => r.model === sol));
	check("real complex classification upgrades luna to sol; post-write continuation remains locked complex");
	const classifierCount = resumed.classifiers.length;
	await prompt(resumed, "Reply exactly OK. Do not call tools.");
	assert.equal(stateOf(resumed.manager).slot, "complex"); assert.equal(stateOf(resumed.manager).stageSeq, 3);
	assert.equal(resumed.classifiers.length, classifierCount);
	check("simple new user after upgrade stays complex without classifier");
	await bounded(resumed, () => resumed.session.compact("Keep the summary brief. Preserve the test files and completed task status."));
	assert.ok(resumed.manager.getBranch().some((e: any) => e.type === "compaction" && e.usage));
	assert.ok(resumed.routes.some((r: any) => r.reason === "direct" && r.model === luna));
	assert.equal(stateOf(resumed.manager).slot, "complex");
	const forkManager = host.SessionManager.open(sessionFile, join(root, "fork-storage"));
	const forkFile = forkManager.createBranchedSession(cheapLeaf);
	resumed.close();
	const afterCompact = await open("after-compact", { sessionFile, cwd });
	assert.equal(stateOf(afterCompact.manager).slot, "complex");
	await continuation(afterCompact);
	assert.equal(afterCompact.routes.at(-1).model, sol); assert.equal(afterCompact.classifiers.length, 0);
	assert.equal(stateOf(afterCompact.manager).stageSeq, 3);
	const originalUsage = await queryUsage(afterCompact); assert.equal(originalUsage.calls, 2); assert.equal(originalUsage.pendingCalls, 0);
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) assert.equal(originalUsage.tokens[key],
		[h.classifiers[0], resumed.classifiers[0]].reduce((sum, c) => sum + (c.usage[key] ?? 0), 0));
	afterCompact.close();
	check("real compaction uses direct luna; reopen preserves complex state and user deduplication");
	const fork = await open("fork", { sessionFile: forkFile, cwd });
	assert.equal(stateOf(fork.manager).slot, "implementation"); assert.equal(stateOf(fork.manager).stageSeq, 2);
	await continuation(fork);
	assert.equal(fork.routes.at(-1).model, luna); assert.equal(fork.classifiers.length, 0);
	const original = host.SessionManager.open(sessionFile, join(root, "original-inspect"));
	assert.equal(stateOf(original).slot, "complex"); assert.equal(stateOf(original).stageSeq, 3);
	assert.deepEqual(await queryUsage(fork), initialUsage); assert.deepEqual(await queryUsage(fork, "session"), { ...initialUsage, scope: "session" });
	assert.equal(summarizeClassifierUsage(original).calls, 2); fork.close();
	check("persisted fork inherits selected ancestor implementation while original remains complex");
}
async function cancel() {
	const h = await open("cancel"); h.cancelOnClassifier = true;
	try { await bounded(h, () => h.session.prompt("Reply OK; do not use tools.")); } catch (error: any) { if (error?.name !== "AbortError") throw error; }
	await h.session.waitForIdle(); if (h.abortPromise) await h.abortPromise;
	await Promise.all([...h.pending]);
	assert.ok(h.events.some((e: any) => e.type === "classifier-http-start"));
	assert.ok(h.events.some((e: any) => e.type === "caller-abort"));
	assert.equal(h.classifiers.at(-1)?.stopReason, "aborted");
	assert.equal(h.dispatches.length, 0); assert.equal(stateOf(h.manager), undefined);
	const summary = await queryUsage(h); assert.equal(summary.calls, 1); assert.equal(summary.pendingCalls, 0);
	assert.equal(summary.missingUsageCalls, 1); assert.equal(summary.cost, "unknown");
	h.close(); check("abort after real classifier HTTP start settles with zero chat requests and zero router state");
}
async function retry() {
	const h = await open("retry"); h.faultArmed = true;
	await prompt(h, "Reply exactly OK without tools.");
	assert.ok(h.events.some((e: any) => e.type === "injected-http-503"));
	assert.ok(h.events.some((e: any) => e.type === "auto_retry_start"));
	const r = h.routes.find((r: any) => r.reason === "retry"); assert.ok(r, "Host retry route not observed");
	assert.equal(r.failedModel, sol); assert.equal(r.model, sol); assert.equal(r.failedThinkingLevel, "low"); assert.equal(r.thinkingLevel, "low");
	assert.equal(stateOf(h.manager).stageSeq, 1); assert.equal(stateOf(h.manager).handoff, "locked");
	assert.equal(h.classifiers.length, 1);
	const summary = await queryUsage(h); assert.equal(summary.calls, 1); assert.equal(summary.pendingCalls, 0);
	assert.equal(summary.tokens.input, h.classifiers[0].usage.input); assert.equal(summary.tokens.output, h.classifiers[0].usage.output); h.close();
	check("injected 503 reaches host auto-retry; real LLM recovery keeps failed model/thinking and does not add stage");
}
try {
	console.log("ARTIFACTS " + root);
	if (scenario === "core") await core(); else if (scenario === "fixed") await fixed(); else if (scenario === "cancel") await cancel(); else await retry();
	evidence.status = "passed";
} catch (error: any) {
	evidence.status = "failed"; evidence.failure = { name: error?.name, code: error?.code,
		assertion: error instanceof assert.AssertionError ? error.message : undefined };
	if (active?.session) { try { active.close(); } catch {} }
	console.error(JSON.stringify(evidence.failure)); process.exitCode = 1;
} finally {
	clearTimeout(wallTimer); clearTimeout(active?.abortTimer); globalThis.fetch = nativeFetch;
	if (savedConfig === undefined) delete process.env.JEV_ROUTER_CONFIG; else process.env.JEV_ROUTER_CONFIG = savedConfig;
	if (savedDebug === undefined) delete process.env.JEV_ROUTER_DEBUG; else process.env.JEV_ROUTER_DEBUG = savedDebug;
	evidence.finishedAt = new Date().toISOString(); evidence.httpCount = httpCount; evidence.chatDispatchCount = chatCount; persist();
	console.log(JSON.stringify({ status: evidence.status, scenario, checks: evidence.checks.length, httpCount, chatCount, evidenceFile: join(root, "evidence.json") }));
}
