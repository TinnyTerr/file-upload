import { createApp } from "./app.ts";
import { createAppState } from "./appState.ts";
import { ensureMaster } from "./bootstrap.ts";
import { initSelfState } from "./cluster/election.ts";
import { ClusterFirehoseConsumer } from "./cluster/firehoseClient.ts";
import { joinCluster } from "./cluster/membership.ts";
import { configValue, environmentKeys, loadSettings } from "./config.ts";
import { createDb } from "./db/index.ts";
import { startBackendWorkers } from "./jobs/scheduler.ts";
import { getLogger } from "./logging.ts";
import { setupWebSockets } from "./ws.ts";

const log = getLogger("app.main");

const settings = loadSettings();
log.info(`application startup begin database_url=${settings.databaseUrl}`);
// Names only -- several of these carry secrets. Worth one line: these are the
// keys whose value `data/app.env` no longer decides, and the admin panel will
// refuse to write them.
const envManaged = environmentKeys();
if (envManaged.length) {
	log.info(
		`configuration overridden by the environment: ${envManaged.join(", ")} (config file ${settings.configPath})`,
	);
}
if (settings.trustProxyMode !== "off") {
	log.info(`trusting proxy headers mode=${settings.trustProxyMode}`);
}
if (!settings.allowedHosts) {
	log.warning(
		"ALLOWED_HOSTS is not set -- WebAuthn relying-party ID is derived from the request's Origin header and the https redirect trusts proxy headers for any host. Set ALLOWED_HOSTS in data/app.env for production.",
	);
}
const db = createDb(settings.databaseUrl);
const state = createAppState(settings, db);

await ensureMaster(db);
// Seed this node's election state (cluster/election.ts) from NODE_ROLE on
// first ever boot; a no-op on every later boot since persisted role/epoch
// always wins over env config. Must run before anything else (heartbeat,
// join, the scheduler) reads or writes cluster_self_state.
initSelfState(db, settings);
state.eventWriter.start();
startBackendWorkers(state);

const firehoseConsumer = new ClusterFirehoseConsumer(state);
firehoseConsumer.start();

// Non-master nodes bootstrap into the mesh from MASTER_URL/MASTER_TOKEN in
// the background so a slow/unreachable master never blocks startup.
void joinCluster(state).catch((err) => {
	log.warning(
		`cluster auto-join failed: ${err instanceof Error ? err.message : String(err)}`,
	);
});

const app = createApp(state);
const port = Number(configValue("PORT") || 8000);

// The websocket firehose (/ws/events, /admin/cluster/firehose) needs the
// raw http.Server that app.listen() returns -- Express itself has no
// websocket support.
const server = app.listen(port, () => {
	log.info(`fileupload server listening on :${port} (env=${settings.appEnv})`);
});
setupWebSockets(server, state);
