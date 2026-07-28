import { EventBus } from "./cluster/eventBus.ts";
import { ClusterEventWriter } from "./cluster/eventStore.ts";
import { HaltRegistry } from "./cluster/halt.ts";
import type { Settings } from "./config.ts";
import type { Db } from "./db/types.ts";
import { LockoutPolicy } from "./security/lockout.ts";
import {
	LoginChallengeRegistry,
	WsTokenRateLimiter,
} from "./security/loginChallenges.ts";
import { SecondFactorTicketRegistry } from "./security/secondFactorTickets.ts";
import { SessionManager } from "./security/sessions.ts";

export interface AppState {
	settings: Settings;
	db: Db;
	sessionManager: SessionManager;
	lockout: LockoutPolicy;
	/** Mutable copy of the cluster token -- distinct from settings.clusterToken
	 * because POST /cluster/token/rotate must update it in-place for the
	 * lifetime of the process (mirrors app/deps.py's AppState.cluster_token). */
	clusterToken: string;
	eventBus: EventBus;
	eventWriter: ClusterEventWriter;
	haltRegistry: HaltRegistry;
	loginChallenges: LoginChallengeRegistry;
	secondFactorTickets: SecondFactorTicketRegistry;
	wsTokenRateLimiter: WsTokenRateLimiter;
}

export function createAppState(settings: Settings, db: Db): AppState {
	const secure = settings.appEnv !== "dev";
	const eventBus = new EventBus(settings);
	const eventWriter = new ClusterEventWriter(db);
	eventBus.setPersistHook((event) => eventWriter.submit(event));
	return {
		settings,
		db,
		sessionManager: new SessionManager(settings.secretKey, secure),
		lockout: new LockoutPolicy(),
		clusterToken: settings.clusterToken,
		eventBus,
		eventWriter,
		haltRegistry: new HaltRegistry(),
		loginChallenges: new LoginChallengeRegistry(),
		secondFactorTickets: new SecondFactorTicketRegistry(),
		wsTokenRateLimiter: new WsTokenRateLimiter(),
	};
}
