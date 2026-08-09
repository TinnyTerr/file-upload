/**
 * Configuration resolution: `data/app.env` and the process environment are one
 * namespace, with the environment winning (server/src/config.ts).
 *
 * These tests mutate `process.env`, so every one of them restores what it
 * touched -- the resolver reads the live environment on every call, and a leaked
 * variable would silently reconfigure whatever test ran next.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ConfigLockedError,
	configValue,
	environmentKeys,
	isEnvManaged,
	loadSettings,
	resetConfigCache,
	setEnvValue,
} from "../src/config.ts";

const touched: string[] = [];

function setEnv(key: string, value: string): void {
	touched.push(key);
	process.env[key] = value;
}

afterEach(() => {
	for (const key of touched.splice(0)) delete process.env[key];
	// These tests point loadSettings at temp files; the rest of the suite must
	// not inherit one as its config.
	resetConfigCache();
});

function tempConfig(body?: string): string {
	const path = join(
		mkdtempSync(join(tmpdir(), "fileupload-config-")),
		"app.env",
	);
	if (body !== undefined) writeFileSync(path, body, { mode: 0o600 });
	return path;
}

/** A config file with the two keys loadSettings insists on, plus `extra`. */
function minimalConfig(extra = ""): string {
	return tempConfig(
		`SECRET_KEY=from-file\nMASTER_KEY_B64=${Buffer.alloc(32).toString("base64")}\n${extra}`,
	);
}

describe("environment overlay", () => {
	test("an environment variable overrides the same key in app.env", () => {
		const path = minimalConfig("NODE_NAME=from-file\nAPP_ENV=dev\n");
		expect(loadSettings(path).nodeName).toBe("from-file");

		setEnv("NODE_NAME", "from-env");
		expect(loadSettings(path).nodeName).toBe("from-env");
	});

	test("an environment variable supplies a key the file never had", () => {
		const path = minimalConfig();
		expect(loadSettings(path).masterUrl).toBe("");

		setEnv("MASTER_URL", "https://master.example");
		setEnv("NODE_REGION", "eu-west");
		const settings = loadSettings(path);
		expect(settings.masterUrl).toBe("https://master.example");
		expect(settings.nodeRegion).toBe("eu-west");
	});

	test("the file is never rewritten with what the environment supplied", () => {
		const path = minimalConfig("NODE_NAME=from-file\n");
		setEnv("NODE_NAME", "from-env");
		loadSettings(path);
		expect(readFileSync(path, "utf-8")).toContain("NODE_NAME=from-file");
		expect(readFileSync(path, "utf-8")).not.toContain("from-env");
	});

	test("an empty variable blanks a value the file sets", () => {
		// `ALLOWED_HOSTS= bun run start` is a real thing to want; "set to empty"
		// has to be distinguishable from "not set" or it can't be expressed.
		const path = minimalConfig("ALLOWED_HOSTS=example.com\n");
		setEnv("ALLOWED_HOSTS", "");
		expect(loadSettings(path).allowedHosts).toBe("");
	});

	test("a variable that is neither a config key nor in the file is ignored", () => {
		const path = minimalConfig();
		loadSettings(path);
		setEnv("HOME_DIRECTORY_OF_SOMETHING", "/nope");
		expect(configValue("HOME_DIRECTORY_OF_SOMETHING")).toBeUndefined();
		expect(environmentKeys()).not.toContain("HOME_DIRECTORY_OF_SOMETHING");
	});

	test("a key the file carries is overridable even outside CONFIG_KEYS", () => {
		// Whatever you can put in app.env you can also set in the environment --
		// the bounded key list only stops a stray variable from inventing a value
		// the app never had.
		const path = minimalConfig("FUTURE_KNOB=file\n");
		loadSettings(path);
		expect(configValue("FUTURE_KNOB")).toBe("file");
		setEnv("FUTURE_KNOB", "env");
		expect(configValue("FUTURE_KNOB")).toBe("env");
		expect(environmentKeys()).toContain("FUTURE_KNOB");
	});

	test("process-level knobs resolve from app.env too", () => {
		// The overlay runs both ways: PORT and the storage roots were environment-
		// only, and are now ordinary config entries.
		const path = minimalConfig("PORT=9123\nFILEUPLOAD_STORAGE=/srv/blobs\n");
		loadSettings(path);
		expect(configValue("PORT")).toBe("9123");
		expect(configValue("FILEUPLOAD_STORAGE")).toBe("/srv/blobs");

		setEnv("PORT", "9999");
		expect(configValue("PORT")).toBe("9999");
	});

	test("configValue falls back only when neither source answers", () => {
		const path = minimalConfig("LOG_LEVEL=DEBUG\n");
		loadSettings(path);
		expect(configValue("LOG_LEVEL", "INFO")).toBe("DEBUG");
		expect(configValue("REPLICATION_MODE", "full")).toBe("full");
	});
});

describe("generated config", () => {
	test("a key the environment supplies is not written into the new file", () => {
		// A persisted copy of an overlay is a second answer that takes over the
		// day the variable is dropped. The key is recorded as a comment so the
		// file still says where the value comes from.
		setEnv("NODE_ID", "env-node");
		setEnv("SECRET_KEY", "env-secret");
		const path = tempConfig();
		const settings = loadSettings(path);

		expect(settings.nodeId).toBe("env-node");
		expect(settings.secretKey).toBe("env-secret");
		const written = readFileSync(path, "utf-8");
		expect(written).not.toContain("env-secret");
		expect(written).toContain("# SECRET_KEY is set in this node's environment");
		expect(written).toContain("# NODE_ID is set in this node's environment");
		// Everything the environment didn't supply is still written normally.
		expect(written).toContain("MASTER_KEY_B64=");
	});

	test("dropping the variable later is a loud failure, not a silent new identity", () => {
		setEnv("SECRET_KEY", "env-secret");
		const path = tempConfig();
		loadSettings(path);

		delete process.env.SECRET_KEY;
		expect(() => loadSettings(path)).toThrow(/SECRET_KEY/);
	});

	test("secrets absent from both sources are still minted into the file", () => {
		const path = tempConfig();
		const settings = loadSettings(path);
		expect(settings.secretKey).not.toBe("");
		expect(settings.nodeId).not.toBe("");
		expect(readFileSync(path, "utf-8")).toContain(
			`SECRET_KEY=${settings.secretKey}`,
		);
	});

	test("an environment-supplied CLUSTER_TOKEN suppresses the backfill", () => {
		setEnv("CLUSTER_TOKEN", "shared-token");
		const path = minimalConfig();
		expect(loadSettings(path).clusterToken).toBe("shared-token");
		expect(readFileSync(path, "utf-8")).not.toContain("CLUSTER_TOKEN");
	});
});

describe("setEnvValue", () => {
	test("writes a key the environment leaves alone", () => {
		const path = minimalConfig();
		loadSettings(path);
		setEnvValue(path, "REALDEBRID_API_KEY", "abc123");
		expect(readFileSync(path, "utf-8")).toContain("REALDEBRID_API_KEY=abc123");
		// The resolver sees the write immediately, without a re-read.
		expect(configValue("REALDEBRID_API_KEY")).toBe("abc123");
	});

	test("refuses a key fixed by the environment, and writes nothing", () => {
		const path = minimalConfig("REALDEBRID_API_KEY=from-file\n");
		setEnv("REALDEBRID_API_KEY", "from-env");
		loadSettings(path);

		expect(isEnvManaged("REALDEBRID_API_KEY")).toBe(true);
		let thrown: unknown;
		try {
			setEnvValue(path, "REALDEBRID_API_KEY", "from-admin");
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(ConfigLockedError);
		expect((thrown as ConfigLockedError).status).toBe(409);
		// The refusal is the point: the file must not end up holding a value the
		// running process is ignoring.
		expect(readFileSync(path, "utf-8")).toContain(
			"REALDEBRID_API_KEY=from-file",
		);
		expect(configValue("REALDEBRID_API_KEY")).toBe("from-env");
	});
});
