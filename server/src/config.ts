import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, chmodSync, closeSync, writeSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";

export interface Settings {
  appEnv: string;
  databaseUrl: string;
  secretKey: string;
  masterKeyB64: string;
  configPath: string;
  trustProxy: boolean;
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
  ]);
  const fd = openSync(path, "wx", 0o600);
  writeSync(fd, serializeEnvFile(map));
  closeSync(fd);
  chmodSync(path, 0o600);
}

export function setEnvValue(path: string, key: string, value: string): void {
  const map = existsSync(path) ? parseEnvFile(readFileSync(path, "utf-8")) : new Map<string, string>();
  map.set(key, value);
  const fd = openSync(path, "w", 0o600);
  writeSync(fd, serializeEnvFile(map));
  closeSync(fd);
}

function truthy(value: string | undefined): boolean {
  return (value ?? "").toLowerCase() === "true";
}

export function loadSettings(configPathArg?: string): Settings {
  const configPath = configPathArg || process.env.FILEUPLOAD_CONFIG || "./data/app.env";

  if (!existsSync(configPath)) {
    generateFile(configPath);
  }

  let map = parseEnvFile(readFileSync(configPath, "utf-8"));

  if (!map.get("SECRET_KEY") || !map.get("MASTER_KEY_B64")) {
    throw new Error("SECRET_KEY and MASTER_KEY_B64 must be set in the config file");
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

  return {
    appEnv: map.get("APP_ENV") || "dev",
    databaseUrl: map.get("DATABASE_URL") || "sqlite:///./data/app.db",
    secretKey: map.get("SECRET_KEY")!,
    masterKeyB64: map.get("MASTER_KEY_B64")!,
    configPath,
    trustProxy: truthy(map.get("TRUST_PROXY")),
    allowedHosts: map.get("ALLOWED_HOSTS") || "",
    clusterToken: map.get("CLUSTER_TOKEN") || "",
    nodeId: map.get("NODE_ID") || "",
    nodeName: map.get("NODE_NAME") || "",
    nodeRole: map.get("NODE_ROLE") || "master",
    nodeUrl: map.get("NODE_URL") || "",
    masterUrl: map.get("MASTER_URL") || "",
    masterToken: map.get("MASTER_TOKEN") || "",
    archiveEnabled: map.get("ARCHIVE_ENABLED") ? truthy(map.get("ARCHIVE_ENABLED")) : true,
    replicationMode: map.get("REPLICATION_MODE") || "full",
    cacheMaxBytes: Number(map.get("CACHE_MAX_BYTES") || "0"),
  };
}
