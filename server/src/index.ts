import { loadSettings } from "./config.ts";
import { createDb } from "./db/index.ts";
import { createAppState } from "./appState.ts";
import { ensureMaster } from "./bootstrap.ts";
import { createApp } from "./app.ts";
import { getLogger } from "./logging.ts";
import { startBackendWorkers } from "./jobs/scheduler.ts";
import { setupWebSockets } from "./ws.ts";
import { joinCluster } from "./cluster/membership.ts";
import { ClusterFirehoseConsumer } from "./cluster/firehoseClient.ts";

const log = getLogger("app.main");

const settings = loadSettings();
log.info(`application startup begin database_url=${settings.databaseUrl}`);
if (settings.trustProxyMode !== "off") {
  log.info(`trusting proxy headers mode=${settings.trustProxyMode}`);
}
const db = createDb(settings.databaseUrl);
const state = createAppState(settings, db);

await ensureMaster(db);
state.eventWriter.start();
startBackendWorkers(state);

const firehoseConsumer = new ClusterFirehoseConsumer(state);
firehoseConsumer.start();

// Non-master nodes bootstrap into the mesh from MASTER_URL/MASTER_TOKEN in
// the background so a slow/unreachable master never blocks startup.
void joinCluster(state).catch((err) => {
  log.warning(`cluster auto-join failed: ${err instanceof Error ? err.message : String(err)}`);
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
