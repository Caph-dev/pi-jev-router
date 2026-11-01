import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";

import factory from "../extensions/jev-router.ts";

const CONFIG_ENV = "JEV_ROUTER_CONFIG";
const AGENT_ENV = "PI_CODING_AGENT_DIR";
const STATE_FILE = "jev-router-state.json";
const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string }).version;

const saved = { explicit: process.env[CONFIG_ENV], agentDir: process.env[AGENT_ENV] };
const tempDirs: string[] = [];

afterEach(() => {
	mock.restoreAll();
	if (saved.explicit === undefined) delete process.env[CONFIG_ENV];
	else process.env[CONFIG_ENV] = saved.explicit;
	if (saved.agentDir === undefined) delete process.env[AGENT_ENV];
	else process.env[AGENT_ENV] = saved.agentDir;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	// Resolved: `tmpdir()` on macOS is a symlink short of `/private`, and the extension builds its
	// paths from the environment value it is given.
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "jev-router-upgrade-")));
	tempDirs.push(dir);
	return dir;
}

type Handler = (event: unknown, ctx: unknown) => unknown;

function boot(options: { ui?: boolean; hook?: boolean; notify?: (text: string, level: string) => void } = {}) {
	const handlers: Handler[] = [];
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	(factory as unknown as (pi: Record<string, unknown>) => void)({
		...(options.hook === false ? {} : { on: (event: string, handler: Handler) => { if (event === "session_start") handlers.push(handler); return () => {}; } }),
		registerVirtualModel: () => {},
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => void commands.set(name, command.handler),
		getSettings: () => ({}),
	});
	const notifications: { text: string; level: string }[] = [];
	const notify = options.notify ?? ((text: string, level: string) => void notifications.push({ text, level }));
	const ctx = { hasUI: options.ui !== false, ui: { notify } };
	const lines: string[] = [];
	mock.method(console, "log", (...args: unknown[]) => void lines.push(args.map(String).join(" ")));
	const start = () => {
		for (const handler of handlers) handler({ type: "session_start", reason: "startup" }, ctx);
	};
	return { handlers, commands, notifications, lines, start };
}

function writeConfig(dir: string, value: unknown): string {
	const path = join(dir, "jev-router.json");
	writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
	return path;
}

function readState(dir: string): { schemaVersion: number; version: string; adaptiveApplied: boolean } {
	return JSON.parse(readFileSync(join(dir, STATE_FILE), "utf-8"));
}

function mtimeNs(path: string): bigint {
	return statSync(path, { bigint: true }).mtimeNs;
}

describe("post-update setup notice", () => {
	it("reminds a fresh install where to configure models and records the version", () => {
		const dir = tempDir();
		process.env[AGENT_ENV] = dir;
		delete process.env[CONFIG_ENV];
		const session = boot();
		assert.equal(session.handlers.length, 1, "the extension did not register a session_start hook");
		session.start();

		assert.equal(session.notifications.length, 1);
		assert.equal(session.notifications[0].level, "info");
		const text = session.notifications[0].text;
		assert.ok(text.startsWith(`pi-jev-router ${VERSION}: no configuration found.`), text);
		assert.ok(text.includes(`Set "provider", "models" (complex, standard, implementation) and "classifier" in ${join(dir, "jev-router.json")}`), text);
		assert.ok(text.includes("Run /jev-router status to check."), text);
		assert.deepEqual(readState(dir), { schemaVersion: 1, version: VERSION, adaptiveApplied: true });
	});

	it("does not ask for configuration when a file sets provider and models", () => {
		const dir = tempDir();
		process.env[AGENT_ENV] = dir;
		process.env[CONFIG_ENV] = writeConfig(dir, {
			provider: "p",
			models: { complex: "strong", standard: "mid", implementation: "cheap" },
		});
		const session = boot();
		session.start();

		assert.deepEqual(session.notifications, []);
		assert.deepEqual(session.lines, []);
		assert.equal(readState(dir).version, VERSION);
	});

	it("switches a configured fixed strategy to adaptive once and keeps unknown keys", async () => {
		const dir = tempDir();
		process.env[AGENT_ENV] = dir;
		const configPath = writeConfig(dir, { strategy: "fixed", customKey: { keep: true }, adaptive: {} });
		process.env[CONFIG_ENV] = configPath;
		mock.method(console, "error", () => {});
		const session = boot();
		session.start();

		const rewritten = JSON.parse(readFileSync(configPath, "utf-8"));
		assert.equal(rewritten.strategy, "adaptive");
		assert.deepEqual(rewritten.customKey, { keep: true });
		assert.equal(readFileSync(configPath, "utf-8"), JSON.stringify(rewritten, null, 2) + "\n");
		assert.equal(session.notifications.length, 1);
		assert.ok(session.notifications[0].text.includes(
			`pi-jev-router: strategy "fixed" in ${configPath} changed to "adaptive" once. Edit the file to change it back.`,
		), session.notifications[0].text);

		const bytes = readFileSync(configPath, "utf-8");
		const statePath = join(dir, STATE_FILE);
		const state = readFileSync(statePath);
		const configTime = mtimeNs(configPath);
		const stateTime = mtimeNs(statePath);
		session.start();
		assert.equal(readFileSync(configPath, "utf-8"), bytes);
		assert.equal(mtimeNs(configPath), configTime);
		assert.deepEqual(readFileSync(statePath), state);
		assert.equal(mtimeNs(statePath), stateTime);
		assert.equal(session.notifications.length, 1);

		const status = session.commands.get("jev-router");
		assert.ok(status, "the extension did not register its command");
		await status("status", { hasUI: false });
		assert.ok(session.lines.some(line => line.includes("strategy: adaptive")), session.lines.join("\n"));
	});

	it("rewrites a symlinked config through the link", () => {
		const dir = tempDir();
		process.env[AGENT_ENV] = dir;
		const target = join(dir, "dotfiles-config.json");
		writeFileSync(target, JSON.stringify({ strategy: "fixed" }, null, 2) + "\n");
		const link = join(dir, "jev-router.json");
		symlinkSync(target, link);
		process.env[CONFIG_ENV] = link;
		mock.method(console, "error", () => {});
		const session = boot();
		session.start();

		assert.ok(lstatSync(link).isSymbolicLink(), "the config symlink was replaced by a regular file");
		assert.equal(JSON.parse(readFileSync(target, "utf-8")).strategy, "adaptive");
	});

	it("keeps the mode of a config it rewrites", () => {
		const dir = tempDir();
		process.env[AGENT_ENV] = dir;
		const configPath = writeConfig(dir, { strategy: "fixed" });
		chmodSync(configPath, 0o600);
		process.env[CONFIG_ENV] = configPath;
		mock.method(console, "error", () => {});
		const session = boot();
		session.start();

		assert.equal(JSON.parse(readFileSync(configPath, "utf-8")).strategy, "adaptive");
		assert.equal(statSync(configPath).mode & 0o777, 0o600);
	});

	it("rewrites only the highest-precedence file that sets a strategy", () => {
		const agentDir = tempDir();
		const cwd = tempDir();
		process.env[AGENT_ENV] = agentDir;
		delete process.env[CONFIG_ENV];
		const personal = writeConfig(agentDir, { strategy: "record", provider: "p" });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		const project = join(cwd, ".pi", "jev-router.json");
		writeFileSync(project, JSON.stringify({ strategy: "fixed" }, null, 2) + "\n");
		mock.method(console, "error", () => {});
		const previous = process.cwd();
		try {
			process.chdir(cwd);
			boot().start();
		} finally {
			process.chdir(previous);
		}

		assert.equal(JSON.parse(readFileSync(project, "utf-8")).strategy, "adaptive");
		assert.equal(JSON.parse(readFileSync(personal, "utf-8")).strategy, "record");
	});

	it("falls back to a lower-precedence file when the higher one sets no strategy", () => {
		const agentDir = tempDir();
		const cwd = tempDir();
		process.env[AGENT_ENV] = agentDir;
		delete process.env[CONFIG_ENV];
		const personal = writeConfig(agentDir, { strategy: "fixed" });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "jev-router.json"), JSON.stringify({ provider: "p" }, null, 2) + "\n");
		mock.method(console, "error", () => {});
		const previous = process.cwd();
		try {
			process.chdir(cwd);
			boot().start();
		} finally {
			process.chdir(previous);
		}

		assert.equal(JSON.parse(readFileSync(personal, "utf-8")).strategy, "adaptive");
	});

	it("does not switch the strategy again after the user reverts it", () => {
		const dir = tempDir();
		process.env[AGENT_ENV] = dir;
		const configPath = writeConfig(dir, { strategy: "fixed" });
		process.env[CONFIG_ENV] = configPath;
		const first = boot();
		first.start();
		assert.equal(JSON.parse(readFileSync(configPath, "utf-8")).strategy, "adaptive");

		writeFileSync(configPath, JSON.stringify({ strategy: "fixed" }, null, 2) + "\n");
		const statePath = join(dir, STATE_FILE);
		writeFileSync(statePath, JSON.stringify({ ...readState(dir), version: "0.0.0-previous" }, null, 2) + "\n");

		const second = boot();
		second.start();
		assert.equal(JSON.parse(readFileSync(configPath, "utf-8")).strategy, "fixed");
		assert.equal(second.notifications.length, 1);
		assert.ok(second.notifications[0].text.includes("no configuration found"), second.notifications[0].text);
		assert.ok(!second.notifications[0].text.includes("changed to \"adaptive\" once"), second.notifications[0].text);
	});

	it("writes the notice to stdout when the host has no UI", () => {
		const dir = tempDir();
		process.env[AGENT_ENV] = dir;
		delete process.env[CONFIG_ENV];
		const session = boot({ ui: false });
		session.start();

		assert.deepEqual(session.notifications, []);
		assert.equal(session.lines.length, 1);
		assert.ok(session.lines[0].includes("no configuration found"), session.lines[0]);
	});

	it("says and writes nothing on a second start at the same version", () => {
		const dir = tempDir();
		process.env[AGENT_ENV] = dir;
		delete process.env[CONFIG_ENV];
		const session = boot();
		session.start();
		assert.equal(session.notifications.length, 1);
		const statePath = join(dir, STATE_FILE);
		const bytes = readFileSync(statePath);
		const mtime = mtimeNs(statePath);

		session.start();
		assert.equal(session.notifications.length, 1);
		assert.deepEqual(readFileSync(statePath), bytes);
		assert.equal(mtimeNs(statePath), mtime);
		assert.deepEqual(session.lines, []);
	});

	it("never throws into the host when the UI notification fails", () => {
		const dir = tempDir();
		process.env[AGENT_ENV] = dir;
		delete process.env[CONFIG_ENV];
		const errors: string[] = [];
		mock.method(console, "error", (...args: unknown[]) => void errors.push(args.map(String).join(" ")));
		const session = boot({ notify: () => { throw new Error("ui gone"); } });

		assert.doesNotThrow(() => session.start());
		assert.deepEqual(errors, ["[pi-jev-router] diagnostics-unavailable"]);
		assert.equal(readState(dir).version, VERSION);
	});

	it("keeps hosts without the `on` hook working", () => {
		const dir = tempDir();
		process.env[AGENT_ENV] = dir;
		delete process.env[CONFIG_ENV];
		const session = boot({ hook: false });
		assert.deepEqual(session.handlers, []);
		session.start();
		assert.deepEqual(session.notifications, []);
		assert.throws(() => readState(dir));
	});
});
