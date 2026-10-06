/**
 * Config discovery and merging tests.
 *
 * `loadConfig()` reads the environment and the working directory on every call, so each test sets
 * both, and a temp directory per test keeps the user's real config out of the picture.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONFIG, loadConfig } from "../extensions/jev-router.ts";

const CONFIG_ENV = "JEV_ROUTER_CONFIG";
const AGENT_ENV = "PI_CODING_AGENT_DIR";
const FILE_NAME = "jev-router.json";

const saved = {
	explicit: process.env[CONFIG_ENV],
	agentDir: process.env[AGENT_ENV],
	cwd: process.cwd(),
};
const tempDirs: string[] = [];

function tempDir(): string {
	// Resolved: on macOS `tmpdir()` is a symlink target short of `/private`, while `process.cwd()`
	// reports the resolved path, and loadConfig() builds the project path from the cwd.
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "jev-router-")));
	tempDirs.push(dir);
	return dir;
}

/** Write `value` (an object, or raw text) as `<dir>/<name>` and return the path. */
function write(dir: string, value: unknown, name = FILE_NAME): string {
	const path = join(dir, name);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2));
	return path;
}

/** Run `loadConfig()` with `$JEV_ROUTER_CONFIG` pointed at `path`. */
function load(path: string) {
	process.env[CONFIG_ENV] = path;
	return loadConfig();
}

/** Capture `warn()` output, which is written to stderr. */
function captureWarnings(): string[] {
	const messages: string[] = [];
	mock.method(console, "error", (...args: unknown[]) => void messages.push(args.join(" ")));
	return messages;
}

/** Strip `pi-jev-router: <file>: ` so a test can assert on the reason alone. */
function reasons(messages: string[]): string[] {
	const prefix = "pi-jev-router: ";
	return messages.map((message) => {
		assert.ok(message.startsWith(prefix), `unexpected warning: ${message}`);
		const rest = message.slice(prefix.length);
		return rest.slice(rest.indexOf(": ") + 2);
	});
}

/** Point `$JEV_ROUTER_CONFIG` at `path` and assert that loading it fails in a useful way. */
function assertFails(pattern: RegExp, path: string): void {
	process.env[CONFIG_ENV] = path;
	assert.throws(
		() => loadConfig(),
		(error: unknown) => {
			assert.ok(error instanceof Error, `expected an Error, got ${String(error)}`);
			assert.ok(error.message.startsWith("pi-jev-router: "), `unexpected prefix: ${error.message}`);
			assert.ok(error.message.includes(path), `message does not name ${path}: ${error.message}`);
			assert.match(error.message, pattern);
			return true;
		},
	);
}

afterEach(() => {
	mock.restoreAll();
	process.chdir(saved.cwd);
	if (saved.explicit === undefined) delete process.env[CONFIG_ENV];
	else process.env[CONFIG_ENV] = saved.explicit;
	if (saved.agentDir === undefined) delete process.env[AGENT_ENV];
	else process.env[AGENT_ENV] = saved.agentDir;
	for (let dir = tempDirs.pop(); dir; dir = tempDirs.pop()) rmSync(dir, { recursive: true, force: true });
});

describe("discovery", () => {
	it("falls back to the built-in config when no file exists", () => {
		const { config, files } = load(join(tempDir(), "missing.json"));
		assert.deepEqual(config, DEFAULT_CONFIG);
		assert.deepEqual(files, []);
	});

	it("reads the personal file, then the project file over it", () => {
		const root = tempDir();
		const personal = join(root, "agent");
		const project = join(root, "project");
		const personalFile = write(personal, { models: { complex: "from-personal" } });
		const projectFile = write(join(project, ".pi"), { models: { standard: "from-project" } });

		delete process.env[CONFIG_ENV];
		process.env[AGENT_ENV] = personal;
		process.chdir(project);

		const { config, files } = loadConfig();
		assert.equal(config.models.complex, "from-personal");
		assert.equal(config.models.standard, "from-project");
		assert.equal(config.models.implementation, DEFAULT_CONFIG.models.implementation);
		assert.deepEqual(files, [personalFile, projectFile]);
	});

	it("reads no other file when $JEV_ROUTER_CONFIG is set", () => {
		const root = tempDir();
		const project = join(root, "project");
		write(join(root, "agent"), { models: { complex: "from-personal" } });
		write(join(project, ".pi"), { models: { standard: "from-project" } });
		const explicit = write(tempDir(), { models: { complex: "from-explicit" } });

		process.env[AGENT_ENV] = join(root, "agent");
		process.chdir(project);

		const { config, files } = load(explicit);
		assert.equal(config.models.complex, "from-explicit");
		assert.equal(config.models.standard, DEFAULT_CONFIG.models.standard);
		assert.deepEqual(files, [explicit]);
	});
});

describe("example file", () => {
	const path = fileURLToPath(new URL("../jev-router.example.json", import.meta.url));

	it("spells out every key with its built-in default value", () => {
		// Compared as raw JSON: loading it would fill in any key the file leaves out.
		assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), DEFAULT_CONFIG);
	});

	it("is accepted by the config parser", () => {
		assert.deepEqual(load(path).files, [path]);
	});
});

describe("merging", () => {
	it("overrides only the keys the file sets", () => {
		const path = write(tempDir(), { models: { complex: "my-strong", implementation: null }, threshold: 0.8 });
		const { config, files } = load(path);
		assert.equal(config.models.complex, "my-strong");
		assert.equal(config.models.implementation, null);
		assert.equal(config.models.standard, DEFAULT_CONFIG.models.standard);
		assert.equal(config.provider, DEFAULT_CONFIG.provider);
		assert.equal(config.threshold, 0.8);
		assert.deepEqual(files, [path]);
	});

	it("treats false as null for a model slot", () => {
		const { config } = load(write(tempDir(), { models: { implementation: false, direct: "cheap" } }));
		assert.equal(config.models.implementation, null);
		assert.equal(config.models.direct, "cheap");
	});

	it("keeps the classifier provider when only the id is set", () => {
		const { config } = load(write(tempDir(), { classifier: { id: "other" } }));
		assert.deepEqual(config.classifier, { provider: "typesafe", id: "other" });
	});

	it("disables classification with null and with false", () => {
		for (const value of [null, false])
			assert.equal(load(write(tempDir(), { classifier: value })).config.classifier, null);
	});
});

describe("unknown keys", () => {
	it("warns about an unknown top-level key and ignores it", () => {
		const messages = captureWarnings();
		const { config } = load(write(tempDir(), { provider: "anthropic", thrshold: 0.9 }));
		assert.equal(config.provider, "anthropic");
		assert.equal(config.threshold, DEFAULT_CONFIG.threshold);
		assert.deepEqual(reasons(messages), ['ignoring unknown key "thrshold"']);
	});

	it("warns about unknown nested keys and ignores them", () => {
		const messages = captureWarnings();
		const { config } = load(
			write(tempDir(), {
				models: { complx: "typo" },
				virtual: { nmae: "typo" },
				classifier: { name: "typo" },
			}),
		);
		assert.deepEqual(config, DEFAULT_CONFIG);
		assert.deepEqual(reasons(messages), [
			'ignoring unknown key "models.complx"',
			'ignoring unknown key "virtual.nmae"',
			'ignoring unknown key "classifier.name"',
		]);
	});
});

describe("validation", () => {
	it("rejects malformed JSON", () => {
		assertFails(/is not valid JSON/, write(tempDir(), "{ not json"));
	});

	it("rejects a file that is not a JSON object", () => {
		assertFails(/must contain a JSON object/, write(tempDir(), [1, 2]));
	});

	it("rejects a non-object models value", () => {
		assertFails(/"models" must be an object/, write(tempDir(), { models: "nope" }));
	});

	it("rejects an empty model id", () => {
		assertFails(/"models.complex" must be a non-empty string/, write(tempDir(), { models: { complex: "  " } }));
	});

	it("rejects a threshold outside 0..1", () => {
		assertFails(/"threshold" must be a number between 0 and 1/, write(tempDir(), { threshold: 1.5 }));
	});

	it("rejects a promptLimit below 1", () => {
		assertFails(/"promptLimit" must be a number between 1 and 1000000/, write(tempDir(), { promptLimit: 0 }));
	});

	it("rejects an unknown thinking level", () => {
		assertFails(/"virtual.thinkingLevels" contains "nope"; allowed: off, minimal/, write(tempDir(), {
			virtual: { thinkingLevels: ["low", "nope"] },
		}));
	});

	it("rejects an empty thinking level list", () => {
		assertFails(/"virtual.thinkingLevels" must be a non-empty array/, write(tempDir(), {
			virtual: { thinkingLevels: [] },
		}));
	});

	it("rejects a non-boolean debug flag", () => {
		assertFails(/"debug" must be true or false/, write(tempDir(), { debug: "yes" }));
	});
});
