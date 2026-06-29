import { lazy, Suspense } from "react";
import { Routes, Route, Navigate, useSearchParams } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { PublicShell } from "@/components/layout/PublicShell";
import { RequireAuth, RequireMaster, RequirePermission, RedirectIfAuthed } from "@/components/layout/guards";
import { FullPageSpinner } from "@/components/layout/FullPageSpinner";
import { useAuth } from "@/features/auth/hooks/auth";

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
const ClusterPage = lazy(() =>
  import("@/features/cluster/components/ClusterPage").then((m) => ({ default: m.ClusterPage })),
);

function IndexRoute() {
  const [params] = useSearchParams();
  const receiveToken = params.get("receive");
  const { isAuthenticated, isLoading } = useAuth();

  // `/` is the only path the backend always serves the SPA shell for, so the
  // public dropbox "receive" page is hosted here via ?receive=<token>.
  if (receiveToken) {
    return (
      <PublicShell>
        <DropboxUploadPage token={receiveToken} />
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
              <DownloadPage />
            </PublicShell>
          }
        />
        <Route
          path="/d/:slug"
          element={
            <PublicShell>
              <FolderPage />
            </PublicShell>
          }
        />

        {/* App chrome layout — all children require auth */}
        <Route element={<AppShell />}>
          <Route element={<RequireAuth />}>
            <Route path="/files" element={<FilesPage />} />
            <Route path="/account/change" element={<ChangePage />} />
            {/* API keys + docs gated behind the API-keys permission */}
            <Route element={<RequirePermission flag="can_use_api_keys" />}>
              <Route path="/api-keys" element={<ApiKeysPage />} />
              <Route path="/api-docs" element={<ApiDocsPage />} />
            </Route>
            <Route element={<RequirePermission flag="can_manage_cluster" />}>
              <Route path="/cluster" element={<ClusterPage />} />
            </Route>
            <Route element={<RequireMaster />}>
              <Route path="/admin" element={<AdminPage />} />
            </Route>
          </Route>
        </Route>

        <Route path="/" element={<IndexRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
