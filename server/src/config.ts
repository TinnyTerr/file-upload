import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { HttpError } from "./httpError.ts";

/**
 * Configuration has one namespace and two sources: `data/app.env` and the
 * process environment. A variable set on the command line (or in a unit file,
 * or a container's `-e`) is read exactly as if it were a line in `app.env`,
 * and **wins** over one -- which is what lets a value that can only be known
 * at launch be supplied at launch.
 *
 * Two rules make that safe:
 *
 * - **The environment is never written back.** `app.env` is this node's
 *   durable record; the environment is this boot's overlay. Persisting an
 *   overlay would leave a second answer on disk that silently takes over the
 *   day the variable is dropped -- for `SECRET_KEY` that is every session
 *   invalidated, where the *absent* key is a loud startup error instead.
 * - **An environment-supplied key cannot be written from the admin panel.**
 *   `setEnvValue` refuses it rather than persisting a value the running
 *   process would go on ignoring (`ConfigLockedError`).
 */

/** Every key resolved through this module. A key outside this list is only
 * read from the environment when `app.env` already carries it -- so anything
 * you can put in the file you can also set in the environment, but a stray
 * variable named like a config key can't reach a value the app doesn't have.
 *
 * `FILEUPLOAD_CONFIG` is deliberately absent: it names the file, so it can
 * only ever come from the environment. */
export const CONFIG_KEYS = [
	"APP_ENV",
	"DATABASE_URL",
	"SECRET_KEY",
	"MASTER_KEY_B64",
	"TRUST_PROXY",
	"ALLOWED_HOSTS",
	"CLUSTER_TOKEN",
	"NODE_ID",
	"NODE_NAME",
	"NODE_ROLE",
	"NODE_REGION",
	"CLUSTER_REGION_RTT_MS",
	"NODE_URL",
	"MASTER_URL",
	"MASTER_TOKEN",
	"ARCHIVE_ENABLED",
	"REPLICATION_MODE",
	"CACHE_MAX_BYTES",
	"QBITTORRENT_URL",
	"QBITTORRENT_USERNAME",
	"QBITTORRENT_PASSWORD",
	"QBITTORRENT_SAVE_PATH",
	"TORRENT_CONTENT_PATH",
	"QBITTORRENT_SEEDING",
	"QBITTORRENT_SEED_RATIO",
	"QBITTORRENT_SEED_MINUTES",
	"REALDEBRID_API_KEY",
	"REALDEBRID_ENABLED",
	"PORT",
	"LOG_LEVEL",
	"FILEUPLOAD_STORAGE",
	"FILEUPLOAD_THUMBNAILS",
	"FILEUPLOAD_DEBRID",
	"FILEUPLOAD_CHUNK_SIZE",
] as const;

const CONFIG_KEY_SET: ReadonlySet<string> = new Set(CONFIG_KEYS);

/** Thrown when a write would be shadowed by the environment. A 409 rather than
 * a silent no-op: the operator has to change the variable, not the file. */
export class ConfigLockedError extends HttpError {
	constructor(public readonly key: string) {
		super(
			409,
			`${key} is set in this node's environment and cannot be changed here -- change the variable and restart`,
		);
		this.name = "ConfigLockedError";
	}
}

export interface Settings {
	appEnv: string;
	databaseUrl: string;
	secretKey: string;
	masterKeyB64: string;
	configPath: string;
	trustProxy: boolean;
	/** "off" | "proxy" (generic reverse proxy) | "cloudflare" */
	trustProxyMode: "off" | "proxy" | "cloudflare";
	allowedHosts: string;
	clusterToken: string;
	nodeId: string;
	nodeName: string;
	/** Bootstrap role, consulted on the first ever boot and nowhere else --
	 * afterwards this node derives its role from the tiering generation it
	 * holds (cluster/tiering.ts), so an env var cannot override a decision the
	 * cluster has already made. */
	nodeRole: string;
	/** Explicit region name (§5.2, D-3). Set means `region_source =
	 * 'configured'`, which always beats RTT inference. */
	nodeRegion: string;
	/** RTT spread within which two *unconfigured* nodes are taken to share a
	 * region. 0 falls back to the 30 ms default. */
	regionRttThresholdMs: number;
	nodeUrl: string;
	masterUrl: string;
	masterToken: string;
	archiveEnabled: boolean;
	replicationMode: string;
	cacheMaxBytes: number;
	/** qBittorrent WebUI base URL, e.g. http://127.0.0.1:8080. Empty = torrenting disabled. */
	qbittorrentUrl: string;
	qbittorrentUsername: string;
	qbittorrentPassword: string;
	/** Download location as *qBittorrent* sees it (the "set location"). */
	qbittorrentSavePath: string;
	/** The same directory as *this server* sees it -- differs when qBittorrent
	 * runs in a container with a different mount point. Defaults to the save path. */
	torrentContentPath: string;
	/** Keep a qBittorrent torrent seeding after its files have been imported.
	 * The importer *copies* into blob storage rather than moving, so a seeding
	 * torrent is a second full copy on disk until the share limits below retire
	 * it -- which is why those limits exist and why 0/0 is a disk leak. */
	qbittorrentSeeding: boolean;
	/** Share ratio at which a seeding torrent is stopped, removed from
	 * qBittorrent and its downloaded copy deleted. 0 = no ratio limit. */
	qbittorrentSeedRatio: number;
	/** Minutes of seeding after which the same happens. 0 = no time limit.
	 * Whichever limit is reached first wins; with both at 0 a seeding torrent
	 * is never retired on its own. */
	qbittorrentSeedMinutes: number;
	/** Real-Debrid API token (https://real-debrid.com/apitoken). Empty = every
	 * torrent goes straight to qBittorrent. Set from the admin panel, which
	 * rewrites data/app.env and mutates this field in place. */
	realDebridApiKey: string;
	/** Admin kill switch: false routes torrents to qBittorrent even with a key set. */
	realDebridEnabled: boolean;
}

function tokenUrlsafe(bytes: number): string {
	return randomBytes(bytes).toString("base64url");
}

function parseEnvFile(text: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const idx = line.indexOf("=");
		if (idx === -1) continue;
		map.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
	}
	return map;
}

function serializeEnvFile(map: Map<string, string>): string {
	return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}

// ── resolution ──────────────────────────────────────────────────────────────

let cache: { path: string; map: Map<string, string> } | null = null;

function configPathDefault(): string {
	return process.env.FILEUPLOAD_CONFIG || "./data/app.env";
}

/** The parsed config file, read once. `loadSettings` primes this; the handful
 * of knobs read before it runs (the log level) or without it (the storage
 * roots, in tests) fall back to reading the default path lazily. A file that
 * isn't there yet resolves to nothing rather than being generated -- only
 * `loadSettings` creates it. */
function fileValues(): Map<string, string> {
	const path = cache?.path ?? configPathDefault();
	if (!cache || cache.path !== path) {
		cache = {
			path,
			map: existsSync(path)
				? parseEnvFile(readFileSync(path, "utf-8"))
				: new Map(),
		};
	}
	return cache.map;
}

/** Forget the cached file, so the next read resolves `FILEUPLOAD_CONFIG` (or
 * the default path) afresh. For tests that point `loadSettings` at a temp
 * file: without it the rest of the suite would go on resolving `storageRoot()`
 * and friends against that file. */
export function resetConfigCache(): void {
	cache = null;
}

function loadConfigFile(path: string): void {
	cache = {
		path,
		map: existsSync(path)
			? parseEnvFile(readFileSync(path, "utf-8"))
			: new Map(),
	};
}

/** The environment's value for `key`, or undefined if it doesn't supply one.
 * An empty string counts: `ALLOWED_HOSTS= ` on the command line is how you
 * blank a value the file sets. */
function envValue(key: string): string | undefined {
	if (!CONFIG_KEY_SET.has(key) && !fileValues().has(key)) return undefined;
	return process.env[key];
}

/** Resolve one key: environment first, then `app.env`, then `fallback`.
 * A key present but blank resolves to `""` from either source -- callers apply
 * their own `|| default` where blank is meant to mean unset. */
export function configValue(key: string): string | undefined;
export function configValue(key: string, fallback: string): string;
export function configValue(
	key: string,
	fallback?: string,
): string | undefined {
	const env = envValue(key);
	if (env !== undefined) return env;
	return fileValues().get(key) ?? fallback;
}

/** Whether `key` is fixed by the environment for this boot -- i.e. whether
 * writing it to `app.env` would have any effect. */
export function isEnvManaged(key: string): boolean {
	return envValue(key) !== undefined;
}

/** Config keys this process took from its environment, names only: several
 * carry secrets. For the startup log, so an operator debugging a value that
 * "won't change" can see which ones the file no longer decides. */
export function environmentKeys(): string[] {
	const keys = new Set<string>(CONFIG_KEYS);
	for (const key of fileValues().keys()) keys.add(key);
	return [...keys].filter((k) => process.env[k] !== undefined).sort();
}

function generateFile(path: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const defaultAppEnv = process.env.FILEUPLOAD_DEFAULT_APP_ENV || "prod";
	const map = new Map<string, string>([
		["APP_ENV", defaultAppEnv],
		["SECRET_KEY", tokenUrlsafe(32)],
		["MASTER_KEY_B64", Buffer.from(randomBytes(32)).toString("base64")],
		["CLUSTER_TOKEN", tokenUrlsafe(32)],
		["NODE_ID", crypto.randomUUID().replace(/-/g, "")],
		["NODE_NAME", hostname()],
		["NODE_ROLE", "master"],
		["ARCHIVE_ENABLED", "true"],
		["REPLICATION_MODE", "full"],
		["TRUST_PROXY", "false"],
		// Empty = unconfigured (not "deny all"): httpsRedirect.ts falls back to
		// trusting the proxy when this is empty and TRUST_PROXY=true, and
		// webauthn.ts derives the relying-party ID from the request Origin
		// header instead of validating it against this list. Set this in
		// production so both are actually enforced.
		["ALLOWED_HOSTS", ""],
		// Torrenting stays off until a qBittorrent WebUI URL and download
		// location are filled in (see routes/torrents.ts).
		["QBITTORRENT_URL", ""],
		["QBITTORRENT_USERNAME", ""],
		["QBITTORRENT_PASSWORD", ""],
		["QBITTORRENT_SAVE_PATH", ""],
		// Seeding is on by default, bounded by a share ratio and a seeding-time
		// backstop -- an unpopular torrent may never reach ratio 1.0, and without
		// the time limit its downloaded copy would sit on disk forever.
		["QBITTORRENT_SEEDING", "true"],
		["QBITTORRENT_SEED_RATIO", "1.0"],
		["QBITTORRENT_SEED_MINUTES", "10080"],
		// Real-Debrid is the preferred torrent backend when a token is present;
		// qBittorrent is only the fallback. Set from the admin panel.
		["REALDEBRID_API_KEY", ""],
		["REALDEBRID_ENABLED", "true"],
	]);
	// A key the environment already supplies is recorded as a comment instead
	// of a value -- see the header: a persisted copy of an overlay is a second
	// answer that takes over silently when the variable goes away.
	const lines = [...map.entries()].map(([k, v]) =>
		process.env[k] !== undefined
			? `# ${k} is set in this node's environment`
			: `${k}=${v}`,
	);
	const fd = openSync(path, "wx", 0o600);
	writeSync(fd, lines.join("\n") + "\n");
	closeSync(fd);
	chmodSync(path, 0o600);
}

/** Persist one key to `app.env`. Refuses a key the environment supplies:
 * writing it would leave the file and the running process disagreeing, with
 * the file losing. */
export function setEnvValue(path: string, key: string, value: string): void {
	if (isEnvManaged(key)) throw new ConfigLockedError(key);
	const map = existsSync(path)
		? parseEnvFile(readFileSync(path, "utf-8"))
		: new Map<string, string>();
	map.set(key, value);
	const fd = openSync(path, "w", 0o600);
	writeSync(fd, serializeEnvFile(map));
	closeSync(fd);
	if (cache?.path === path) cache.map = map;
}

function truthy(value: string | undefined): boolean {
	return (value ?? "").toLowerCase() === "true";
}

/** A non-negative number, or the fallback when the key is absent, blank or
 * unparseable. An explicit `0` survives -- it is how a seed limit is disabled,
 * so it must not be mistaken for "unset" and replaced by the default. */
function positiveNumber(value: string | undefined, fallback: number): number {
	if (value === undefined || value.trim() === "") return fallback;
	const n = Number(value);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Mirrors app/config.py::get_master_key. */
export function getMasterKey(settings: Settings): Buffer {
	return Buffer.from(settings.masterKeyB64, "base64");
}

export function loadSettings(configPathArg?: string): Settings {
	const configPath = configPathArg || configPathDefault();

	if (!existsSync(configPath)) {
		generateFile(configPath);
	}

	loadConfigFile(configPath);
	// Every read below goes through the resolver, so an environment variable
	// is indistinguishable from the same key written in the file.
	const map = { get: (key: string) => configValue(key) };

	if (!map.get("SECRET_KEY") || !map.get("MASTER_KEY_B64")) {
		throw new Error(
			"SECRET_KEY and MASTER_KEY_B64 must be set in the config file or the environment",
		);
	}

	// Backfill fields introduced after older configs were generated. An
	// environment-supplied value satisfies the check, so these mint into the
	// file only when nothing else answers -- and `setEnvValue`'s refusal is
	// unreachable here for the same reason.
	if (!map.get("CLUSTER_TOKEN")) {
		setEnvValue(configPath, "CLUSTER_TOKEN", tokenUrlsafe(32));
	}
	if (!map.get("NODE_ID")) {
		setEnvValue(configPath, "NODE_ID", crypto.randomUUID().replace(/-/g, ""));
	}

	// TRUST_PROXY accepts "true" (generic reverse proxy) or "cloudflare"
	// (prefer CF-Connecting-IP over X-Forwarded-For).
	const trustProxyRaw = (map.get("TRUST_PROXY") ?? "").toLowerCase();
	const trustProxyMode: Settings["trustProxyMode"] =
		trustProxyRaw === "cloudflare"
			? "cloudflare"
			: trustProxyRaw === "true"
				? "proxy"
				: "off";

	return {
		appEnv: map.get("APP_ENV") || "dev",
		databaseUrl: map.get("DATABASE_URL") || "sqlite:///./data/app.db",
		secretKey: map.get("SECRET_KEY")!,
		masterKeyB64: map.get("MASTER_KEY_B64")!,
		configPath,
		trustProxy: trustProxyMode !== "off",
		trustProxyMode,
		allowedHosts: map.get("ALLOWED_HOSTS") || "",
		clusterToken: map.get("CLUSTER_TOKEN") || "",
		nodeId: map.get("NODE_ID") || "",
		nodeName: map.get("NODE_NAME") || "",
		nodeRole: map.get("NODE_ROLE") || "master",
		nodeRegion: map.get("NODE_REGION") || "",
		regionRttThresholdMs: Number(map.get("CLUSTER_REGION_RTT_MS") || "0"),
		nodeUrl: map.get("NODE_URL") || "",
		masterUrl: map.get("MASTER_URL") || "",
		masterToken: map.get("MASTER_TOKEN") || "",
		archiveEnabled: map.get("ARCHIVE_ENABLED")
			? truthy(map.get("ARCHIVE_ENABLED"))
			: true,
		replicationMode: map.get("REPLICATION_MODE") || "full",
		cacheMaxBytes: Number(map.get("CACHE_MAX_BYTES") || "0"),
		qbittorrentUrl: (map.get("QBITTORRENT_URL") || "").replace(/\/+$/, ""),
		qbittorrentUsername: map.get("QBITTORRENT_USERNAME") || "",
		qbittorrentPassword: map.get("QBITTORRENT_PASSWORD") || "",
		qbittorrentSavePath: map.get("QBITTORRENT_SAVE_PATH") || "",
		torrentContentPath:
			map.get("TORRENT_CONTENT_PATH") || map.get("QBITTORRENT_SAVE_PATH") || "",
		// Absent means "on", matching REALDEBRID_ENABLED: an existing config that
		// predates these keys starts seeding on upgrade, with the ratio and time
		// backstops below applied so it cannot fill the disk unattended.
		qbittorrentSeeding: map.get("QBITTORRENT_SEEDING")
			? truthy(map.get("QBITTORRENT_SEEDING"))
			: true,
		qbittorrentSeedRatio: positiveNumber(map.get("QBITTORRENT_SEED_RATIO"), 1),
		qbittorrentSeedMinutes: positiveNumber(
			map.get("QBITTORRENT_SEED_MINUTES"),
			10080,
		),
		realDebridApiKey: (map.get("REALDEBRID_API_KEY") || "").trim(),
		// Absent means "on" so an admin who only pastes a token gets debrid.
		realDebridEnabled: map.get("REALDEBRID_ENABLED")
			? truthy(map.get("REALDEBRID_ENABLED"))
			: true,
	};
}
