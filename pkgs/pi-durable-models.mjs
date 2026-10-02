#!/usr/bin/env node
// Generates <agent dir>/models.json for the Pi Durable agent. The durable
// harness does not load pi extensions, so the Command Code provider normally
// registered by ~/.pi/personal/extensions/commandcode.ts is mirrored here from
// pi's persisted catalog and the CLI's own API key.
//
// Rerun after `/commandcode-refresh` in pi; the home-manager activation runs it
// on every switch. Missing inputs only warn and keep the existing file.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "durable", "agent");
const modelsPath = join(agentDir, "models.json");
const storePath = join(homedir(), ".pi", "agent", "models-store.json");

function warn(message) {
	console.error(`pi-durable-models: ${message}`);
	process.exit(0);
}

function apiKey() {
	const env = process.env.CMD_API_KEY?.trim();
	if (env) return env;
	try {
		const parsed = JSON.parse(readFileSync(join(homedir(), ".commandcode", "auth.json"), "utf8"));
		if (typeof parsed?.apiKey === "string" && parsed.apiKey.length > 0) return parsed.apiKey;
	} catch {
		// fall through to undefined
	}
	return undefined;
}

let models;
try {
	models = JSON.parse(readFileSync(storePath, "utf8"))?.commandcode?.models;
} catch {
	models = undefined;
}
if (!Array.isArray(models) || models.length === 0) {
	warn(`no commandcode catalog in ${storePath}; run /commandcode-refresh in pi`);
}

const key = apiKey();
if (key === undefined) {
	warn("no Command Code API key (CMD_API_KEY or ~/.commandcode/auth.json)");
}

mkdirSync(agentDir, { recursive: true });
const config = {
	providers: {
		commandcode: {
			name: "Command Code",
			baseUrl: "https://api.commandcode.ai/provider/v1",
			api: "openai-completions",
			apiKey: key,
			models: models.map(({ provider: _provider, ...model }) => model),
		},
	},
};
writeFileSync(modelsPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
chmodSync(modelsPath, 0o600);
console.log(`pi-durable-models: wrote ${modelsPath} (${models.length} models)`);
