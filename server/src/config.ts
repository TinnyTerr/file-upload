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
	nodeRole: string;
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
		// Real-Debrid is the preferred torrent backend when a token is present;
		// qBittorrent is only the fallback. Set from the admin panel.
		["REALDEBRID_API_KEY", ""],
		["REALDEBRID_ENABLED", "true"],
	]);
	const fd = openSync(path, "wx", 0o600);
	writeSync(fd, serializeEnvFile(map));
	closeSync(fd);
	chmodSync(path, 0o600);
}

export function setEnvValue(path: string, key: string, value: string): void {
	const map = existsSync(path)
		? parseEnvFile(readFileSync(path, "utf-8"))
		: new Map<string, string>();
	map.set(key, value);
	const fd = openSync(path, "w", 0o600);
	writeSync(fd, serializeEnvFile(map));
	closeSync(fd);
}

function truthy(value: string | undefined): boolean {
	return (value ?? "").toLowerCase() === "true";
}

/** Mirrors app/config.py::get_master_key. */
export function getMasterKey(settings: Settings): Buffer {
	return Buffer.from(settings.masterKeyB64, "base64");
}

export function loadSettings(configPathArg?: string): Settings {
	const configPath =
		configPathArg || process.env.FILEUPLOAD_CONFIG || "./data/app.env";

	if (!existsSync(configPath)) {
		generateFile(configPath);
	}

	let map = parseEnvFile(readFileSync(configPath, "utf-8"));

	if (!map.get("SECRET_KEY") || !map.get("MASTER_KEY_B64")) {
		throw new Error(
			"SECRET_KEY and MASTER_KEY_B64 must be set in the config file",
		);
	}

	// Backfill fields introduced after older configs were generated.
	if (!map.get("CLUSTER_TOKEN")) {
		setEnvValue(configPath, "CLUSTER_TOKEN", tokenUrlsafe(32));
		map = parseEnvFile(readFileSync(configPath, "utf-8"));
	}
	if (!map.get("NODE_ID")) {
		setEnvValue(configPath, "NODE_ID", crypto.randomUUID().replace(/-/g, ""));
		map = parseEnvFile(readFileSync(configPath, "utf-8"));
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
		realDebridApiKey: (map.get("REALDEBRID_API_KEY") || "").trim(),
		// Absent means "on" so an admin who only pastes a token gets debrid.
		realDebridEnabled: map.get("REALDEBRID_ENABLED")
			? truthy(map.get("REALDEBRID_ENABLED"))
			: true,
	};
}
