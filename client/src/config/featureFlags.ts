/**
 * The Python backend (`app/`) is retired. `server/` (Bun + Express) is the
 * only backend. Ports routes incrementally — see server/TODO_ROUTES.md for
 * what's left. Flip a flag to `true` here once its routes land in `server/`.
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
