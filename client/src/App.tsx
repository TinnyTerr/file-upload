import { lazy, Suspense, type ReactNode } from "react";
import { Routes, Route, Navigate, useSearchParams } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { PublicShell } from "@/components/layout/PublicShell";
import { RequireAuth, RequireMaster, RequirePermission, RedirectIfAuthed } from "@/components/layout/guards";
import { FullPageSpinner } from "@/components/layout/FullPageSpinner";
import { FeatureUnavailable } from "@/components/layout/FeatureUnavailable";
import { useAuth } from "@/features/auth/hooks/auth";
import { isFeatureEnabled, type FeatureFlag } from "@/config/featureFlags";

import { LoginPage } from "@/features/auth/components/LoginPage";
import { ChangePage } from "@/features/auth/components/ChangePage";
import { FilesPage } from "@/features/files/components/FilesPage";

const DownloadPage = lazy(() =>
  import("@/features/download/components/DownloadPage").then((m) => ({ default: m.DownloadPage })),
);
const FolderPage = lazy(() =>
  import("@/features/folder-view/components/FolderPage").then((m) => ({ default: m.FolderPage })),
);
const ApiDocsPage = lazy(() =>
  import("@/features/api-docs/components/ApiDocsPage").then((m) => ({ default: m.ApiDocsPage })),
);
const DropboxUploadPage = lazy(() =>
  import("@/features/dropbox/components/DropboxUploadPage").then((m) => ({ default: m.DropboxUploadPage })),
);
const AdminPage = lazy(() =>
  import("@/features/admin/components/AdminPage").then((m) => ({ default: m.AdminPage })),
);
const ApiKeysPage = lazy(() =>
  import("@/features/apikeys/components/ApiKeysPage").then((m) => ({ default: m.ApiKeysPage })),
);
const TorrentsPage = lazy(() =>
  import("@/features/torrents/components/TorrentsPage").then((m) => ({ default: m.TorrentsPage })),
);
const ClusterPage = lazy(() =>
  import("@/features/cluster/components/ClusterPage").then((m) => ({ default: m.ClusterPage })),
);

/** Renders `children` if the backend feature has been ported, otherwise a placeholder. */
function Gated({ feature, label, children }: { feature: FeatureFlag; label: string; children: ReactNode }) {
  if (!isFeatureEnabled(feature)) return <FeatureUnavailable label={label} />;
  return <>{children}</>;
}

function IndexRoute() {
  const [params] = useSearchParams();
  const receiveToken = params.get("receive");
  const { isAuthenticated, isLoading } = useAuth();

  // `/` is the only path the backend always serves the SPA shell for, so the
  // public dropbox "receive" page is hosted here via ?receive=<token>.
  if (receiveToken) {
    return (
      <PublicShell>
        <Gated feature="dropbox" label="Dropbox uploads">
          <DropboxUploadPage token={receiveToken} />
        </Gated>
      </PublicShell>
    );
  }
  if (isLoading) return <FullPageSpinner />;
  return <Navigate to={isAuthenticated ? "/files" : "/login"} replace />;
}

export default function App() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <Routes>
        {/* Public, unauthenticated */}
        <Route
          path="/login"
          element={
            <RedirectIfAuthed>
              <PublicShell>
                <LoginPage />
              </PublicShell>
            </RedirectIfAuthed>
          }
        />
        <Route
          path="/file/:slug"
          element={
            <PublicShell>
              <Gated feature="files" label="File downloads">
                <DownloadPage />
              </Gated>
            </PublicShell>
          }
        />
        <Route
          path="/d/:slug"
          element={
            <PublicShell>
              <Gated feature="directories" label="Folder downloads">
                <FolderPage />
              </Gated>
            </PublicShell>
          }
        />

        {/* App chrome layout — all children require auth */}
        <Route element={<AppShell />}>
          <Route element={<RequireAuth />}>
            <Route
              path="/files"
              element={
                <Gated feature="files" label="Files">
                  <FilesPage />
                </Gated>
              }
            />
            <Route
              path="/account/change"
              element={
                <Gated feature="account" label="Account settings">
                  <ChangePage />
                </Gated>
              }
            />
            {/* API keys + docs gated behind the API-keys permission */}
            <Route element={<RequirePermission flag="can_use_api_keys" />}>
              <Route
                path="/api-keys"
                element={
                  <Gated feature="keys" label="API keys">
                    <ApiKeysPage />
                  </Gated>
                }
              />
              <Route path="/api-docs" element={<ApiDocsPage />} />
            </Route>
            <Route element={<RequirePermission flag="can_use_torrents" />}>
              <Route
                path="/torrents"
                element={
                  <Gated feature="torrents" label="Torrents">
                    <TorrentsPage />
                  </Gated>
                }
              />
            </Route>
            <Route element={<RequirePermission flag="can_manage_cluster" />}>
              <Route
                path="/cluster"
                element={
                  <Gated feature="cluster" label="Cluster">
                    <ClusterPage />
                  </Gated>
                }
              />
            </Route>
            <Route element={<RequireMaster />}>
              <Route
                path="/admin"
                element={
                  <Gated feature="admin" label="Admin">
                    <AdminPage />
                  </Gated>
                }
              />
            </Route>
          </Route>
        </Route>

        <Route path="/" element={<IndexRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
