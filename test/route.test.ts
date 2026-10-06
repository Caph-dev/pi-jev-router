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
	route: (request: unknown, ctx: unknown) => Promise<{ model: unknown; thinkingLevel: string }>;
};

/** Load the extension against a stub and return the definition it registered. */
function register(models: { contextWindow: number; maxTokens: number }[] = []): Definition {
	let definition: Definition | undefined;
	const pi = {
		registerVirtualModel: (value: Definition) => void (definition = value),
		getSettings: () => ({}),
	};
	// The stub covers the members the extension touches on the paths under test.
	(factory as unknown as (pi: typeof pi) => void)(pi);
	assert.ok(definition, "the extension did not register a virtual model");
	return definition;
}

/** A `ctx` whose catalog holds `ids`, or nothing at all. Model objects are stable references. */
function context(ids: string[]) {
	const catalog = new Map(ids.map((id) => [id, { contextWindow: 1000, maxTokens: 100 }]));
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
