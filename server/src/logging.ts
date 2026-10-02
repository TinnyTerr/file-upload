import pino from "pino";
import { configValue } from "./config.ts";
import { Sentry, sentryEnabled } from "./sentry.ts";

/**
 * Logging built on pino, shaped to match the Python server:
 * - console lines formatted like logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
 * - an in-memory ring buffer (app/observability/log_buffer.py) that powers
 *   GET /admin/backend/logs, capturing every record at DEBUG regardless of
 *   the console level
 * - LOG_LEVEL env override (Python level names accepted), default INFO
 */

const MAX_ENTRIES = 2000;

export interface LogEntry {
	id: number;
	created_at: string;
	level: string;
	logger: string;
	message: string;
	module: string;
	function: string;
	line: number;
}

const entries: LogEntry[] = [];
let nextId = 1;

const PINO_TO_PY: Record<number, string> = {
	10: "DEBUG",
	20: "DEBUG",
	30: "INFO",
	40: "WARNING",
	50: "ERROR",
	60: "CRITICAL",
};

const PY_TO_PINO: Record<string, string> = {
	DEBUG: "debug",
	INFO: "info",
	WARNING: "warn",
	ERROR: "error",
	CRITICAL: "fatal",
};

// ANSI colors, keyed by Python-style level name.
const LEVEL_COLOR: Record<string, string> = {
	DEBUG: "\x1b[36m", // cyan
	INFO: "\x1b[32m", // green
	WARNING: "\x1b[33m", // yellow
	ERROR: "\x1b[31m", // red
	CRITICAL: "\x1b[1;31m", // bold red
};
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;

function consoleLevel(): string {
	// Read through the config resolver, so LOG_LEVEL works as an app.env entry
	// as well as an environment variable. This runs at import time, before
	// loadSettings() -- the resolver reads the default config path lazily for
	// exactly that reason.
	const raw = configValue("LOG_LEVEL", "INFO").toUpperCase();
	return PY_TO_PINO[raw] ?? "info";
}

/** Python asctime: "2026-07-13 12:34:56,789" */
function asctime(epochMs: number): string {
	const d = new Date(epochMs);
	const pad = (n: number, w = 2) => String(n).padStart(w, "0");
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
		`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())},${pad(d.getMilliseconds(), 3)}`
	);
}

const consoleThreshold = pino.levels.values[consoleLevel()] ?? 30;

/** Custom pino destination: every record lands in the ring buffer (DEBUG and
 * up, like the Python handler installed at DEBUG), and records at/above the
 * console level are printed Python-formatter style. */
const sink = {
	write(line: string) {
		let rec: { level: number; time: number; name?: string; msg?: string };
		try {
			rec = JSON.parse(line);
		} catch {
			process.stdout.write(line);
			return;
		}
		const levelName = PINO_TO_PY[rec.level] ?? "INFO";
		const logger = rec.name ?? "app";
		const message = rec.msg ?? "";
		// Every ERROR record is a Sentry event, which covers the route-level
		// "unhandled route error" handlers and app.ts's catch-all in one place.
		if (sentryEnabled && rec.level >= 50) {
			Sentry.captureMessage(message, {
				level: "error",
				tags: { logger },
			});
		}
		entries.push({
			id: nextId++,
			created_at: new Date(rec.time).toISOString(),
			level: levelName,
			logger,
			message,
			module: logger.split(".").pop() ?? logger,
			function: "",
			line: 0,
		});
		if (entries.length > MAX_ENTRIES)
			entries.splice(0, entries.length - MAX_ENTRIES);
		if (rec.level >= consoleThreshold) {
			const stream = rec.level >= 50 ? process.stderr : process.stdout;
			const line = useColor
				? `${DIM}${asctime(rec.time)}${RESET} ${LEVEL_COLOR[levelName] ?? ""}${levelName}${RESET} ${logger}: ${message}\n`
				: `${asctime(rec.time)} ${levelName} ${logger}: ${message}\n`;
			stream.write(line);
		}
	},
};

// Root logs everything so the buffer sees DEBUG records even when the
// console level is INFO; the sink applies the console threshold itself.
const root = pino({ level: "debug", base: undefined }, sink);

export interface Logger {
	debug(msg: string, ...args: unknown[]): void;
	info(msg: string, ...args: unknown[]): void;
	warning(msg: string, ...args: unknown[]): void;
	error(msg: string, ...args: unknown[]): void;
}

type LogFn = (msg: string, ...args: unknown[]) => void;

/** Mirrors logging.getLogger(name); printf-style %s/%d/%j interpolation via pino. */
export function getLogger(name: string): Logger {
	const child = root.child({ name });
	return {
		debug: child.debug.bind(child) as LogFn,
		info: child.info.bind(child) as LogFn,
		warning: child.warn.bind(child) as LogFn,
		error: child.error.bind(child) as LogFn,
	};
}

export interface BackendLogsResult {
	entries: LogEntry[];
	total_count: number;
	filtered_count: number;
	limit: number;
	levels: string[];
}

/** Mirrors app/observability/log_buffer.py::query_backend_logs. */
export function queryBackendLogs(
	opts: { q?: string; level?: string; limit?: number } = {},
): BackendLogsResult {
	const limit = opts.limit ?? 200;
	let snapshot = [...entries];
	const totalCount = snapshot.length;

	const levelName = (opts.level ?? "").trim().toUpperCase();
	if (levelName) snapshot = snapshot.filter((e) => e.level === levelName);

	const needle = (opts.q ?? "").trim().toLowerCase();
	if (needle) {
		const terms = needle.split(/\s+/).filter(Boolean);
		snapshot = snapshot.filter((e) => {
			const haystack = [
				e.id,
				e.created_at,
				e.level,
				e.logger,
				e.message,
				e.module,
				e.function,
				e.line,
			]
				.join(" ")
				.toLowerCase();
			return terms.every((term) => haystack.includes(term));
		});
	}

	return {
		entries: snapshot.reverse().slice(0, limit),
		total_count: totalCount,
		filtered_count: snapshot.length,
		limit,
		levels: ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
	};
}
