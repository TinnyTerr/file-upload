import { loadSettings } from "./config.ts";
import { createDb } from "./db/index.ts";
import { createAppState } from "./appState.ts";
import { ensureMaster } from "./bootstrap.ts";
import { createApp } from "./app.ts";
import { getLogger } from "./logging.ts";
import { startBackendWorkers } from "./jobs/scheduler.ts";

const log = getLogger("app.main");

const settings = loadSettings();
log.info(`application startup begin database_url=${settings.databaseUrl}`);
if (settings.trustProxyMode !== "off") {
  log.info(`trusting proxy headers mode=${settings.trustProxyMode}`);
}
const db = createDb(settings.databaseUrl);
const state = createAppState(settings, db);

await ensureMaster(db);
startBackendWorkers(state);

const app = createApp(state);
const port = Number(process.env.PORT ?? 8000);

app.listen(port, () => {
  log.info(`fileupload server listening on :${port} (env=${settings.appEnv})`);
});
