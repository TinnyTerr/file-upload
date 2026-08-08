import { createApp } from "./app.ts";
import { createAppState } from "./appState.ts";
import { ensureMaster } from "./bootstrap.ts";
import { ClusterFirehoseConsumer } from "./cluster/firehoseClient.ts";
import { joinCluster } from "./cluster/membership.ts";
import { initTiering } from "./cluster/tiering.ts";
import { loadSettings } from "./config.ts";
import { createDb } from "./db/index.ts";
import { startBackendWorkers } from "./jobs/scheduler.ts";
import { getLogger } from "./logging.ts";
import { setupWebSockets } from "./ws.ts";

const log = getLogger("app.main");

const settings = loadSettings();
log.info(`application startup begin database_url=${settings.databaseUrl}`);
if (settings.trustProxyMode !== "off") {
	log.info(`trusting proxy headers mode=${settings.trustProxyMode}`);
}
if (!settings.allowedHosts) {
	log.warning(
		"ALLOWED_HOSTS is not set -- WebAuthn relying-party ID is derived from the request's Origin header and the https redirect trusts proxy headers for any host. Set ALLOWED_HOSTS in data/app.env for production.",
	);
}
const db = createDb(settings.databaseUrl);
// Mint this node's first tiering generation from NODE_ROLE (cluster/
// tiering.ts) on first ever boot; on every later boot it only re-mirrors the
// generation already held, because a role the cluster has decided must not be
// overridable by an env var. Must run before anything else (heartbeat, join,
// the scheduler) reads a role -- and before createAppState, whose change-log
// seed reads `replication_control.is_master` to decide whether this node
// assigns master_seq.
initTiering(db, settings);
const state = createAppState(settings, db);

await ensureMaster(db);
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
const port = Number(process.env.PORT ?? 8000);

// The websocket firehose (/ws/events, /admin/cluster/firehose) needs the
// raw http.Server that app.listen() returns -- Express itself has no
// websocket support.
const server = app.listen(port, () => {
	log.info(`fileupload server listening on :${port} (env=${settings.appEnv})`);
});
setupWebSockets(server, state);
