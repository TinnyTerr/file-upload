import {
	isMasterNode,
	seedChangeLog,
	setNodeIdentity,
} from "./cluster/changelog.ts";
import { MasterReachability } from "./cluster/degraded.ts";
import { EventBus } from "./cluster/eventBus.ts";
import { ClusterEventWriter } from "./cluster/eventStore.ts";
import { HaltRegistry } from "./cluster/halt.ts";
import { seedLegacyManifests } from "./cluster/placement.ts";
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
	/** Master-reachability state machine + held-request queue (§5.5). Process-
	 * local by nature: this node's opinion about a peer, not cluster state. */
	masterReachability: MasterReachability;
}

export function createAppState(settings: Settings, db: Db): AppState {
	const secure = settings.appEnv !== "dev";
	// Arm the replication triggers installed by the DB adapter: until the node
	// has an identity they deliberately do nothing, which is what keeps the boot
	// uid backfill out of the log. Nothing writes between createDb and here.
	setNodeIdentity(db, settings.nodeId);
	// A database that predates the change log gets one describing what it
	// already holds, so a peer joining later receives the existing corpus
	// through the ordinary pull path rather than a separate snapshot endpoint.
	seedChangeLog(db);
	// After the seed, never before: recording a manifest appends log entries,
	// and a non-empty log is exactly what makes `seedChangeLog` decide it has
	// already run. Master-only, because a manifest has one writer cluster-wide
	// (cluster/placement.ts::recordManifest) and two nodes seeding the same
	// legacy blob would ship two sets of rows for it.
	if (isMasterNode(db)) seedLegacyManifests(db);
	const eventBus = new EventBus(settings);
	const eventWriter = new ClusterEventWriter(db);
	// Locally-originated events persist synchronously (see eventWriter.write):
	// once an event is visible to a subscriber or a polling peer it must
	// already be durable, and it must not re-use a sequence number this node
	// emitted before its last restart.
	eventBus.setPersistHook((event) => eventWriter.write(event));
	eventBus.seedSeq(
		db.get<{ max_seq: number | null }>(
			"SELECT MAX(origin_seq) AS max_seq FROM cluster_events WHERE origin_node_id = $nodeId",
			{ $nodeId: settings.nodeId },
		)?.max_seq ?? 0,
	);
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
		masterReachability: new MasterReachability(),
	};
}
