/// <reference types="vite/client" />

/** Web DSN from the repo-root .env (SENTRY_DSN_WEB), injected by vite.config.ts. */
declare const __SENTRY_DSN__: string;

/** `fileupload@<version>+<sha>`, identical to the server's SENTRY_RELEASE. */
declare const __SENTRY_RELEASE__: string;
/** 0..1, from SENTRY_TRACES_SAMPLE_RATE (default 0.1). */
declare const __SENTRY_TRACES_RATE__: number;
/** 0..1, from SENTRY_REPLAY_SAMPLE_RATE (default 0.05). Error replays are always kept. */
declare const __SENTRY_REPLAY_RATE__: number;
