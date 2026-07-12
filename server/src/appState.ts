import type { Db } from "./db/types.ts";
import type { Settings } from "./config.ts";
import { SessionManager } from "./security/sessions.ts";
import { LockoutPolicy } from "./security/lockout.ts";

export interface AppState {
  settings: Settings;
  db: Db;
  sessionManager: SessionManager;
  lockout: LockoutPolicy;
}

export function createAppState(settings: Settings, db: Db): AppState {
  const secure = settings.appEnv !== "dev";
  return {
    settings,
    db,
    sessionManager: new SessionManager(settings.secretKey, secure),
    lockout: new LockoutPolicy(),
  };
}
