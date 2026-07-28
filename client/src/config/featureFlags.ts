/**
 * The Python backend (`app/`) is retired. `server/` (Bun + Express) is the
 * only backend, and the route port is complete -- every flag below is `true`.
 * Kept around as the toggle point should a future route ever need to be
 * disabled without ripping out its UI.
 */
export const FEATURES = {
  files: true,
  directories: true,
  account: true,
  keys: true,
  dropbox: true,
  admin: true,
  audit: true,
  remoteUpload: true,
  cluster: true,
  torrents: true,
} as const;

export type FeatureFlag = keyof typeof FEATURES;

export function isFeatureEnabled(flag: FeatureFlag): boolean {
  return FEATURES[flag];
}
