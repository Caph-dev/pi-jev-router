import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

it("live smoke refuses to run before loading personal configuration without explicit opt-in", () => {
	const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/live-agent-smoke.ts", import.meta.url)), "fixed"],
		{ encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 5000 });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Set JEV_ROUTER_LIVE=1 to authorize billable calls/);
	assert.equal(result.stdout, "");
});
