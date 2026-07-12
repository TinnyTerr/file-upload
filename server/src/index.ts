import { loadSettings } from "./config.ts";
import { createDb } from "./db/index.ts";
import { createAppState } from "./appState.ts";
import { ensureMaster } from "./bootstrap.ts";
import { createApp } from "./app.ts";

const settings = loadSettings();
const db = createDb(settings.databaseUrl);
const state = createAppState(settings, db);

await ensureMaster(db);

const app = createApp(state);
const port = Number(process.env.PORT ?? 8000);

app.listen(port, () => {
  console.log(`fileupload server listening on :${port} (env=${settings.appEnv})`);
});
