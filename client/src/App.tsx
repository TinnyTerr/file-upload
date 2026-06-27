import { Navigate, Route, Routes } from "react-router-dom";
import { isLoggedIn } from "./lib/api";
import { RequireAuth, RequireMaster } from "./features/auth/hooks/auth";
import { Nav } from "./components/layout/Nav";
import { LoginPage } from "./features/auth/components/LoginPage";
import { ChangePage } from "./features/auth/components/ChangePage";
import { FilesPage } from "./features/files/components/FilesPage";
import { AdminPage } from "./features/admin/components/AdminPage";
import { ApiDocsPage } from "./features/api-docs/components/ApiDocsPage";
import { DirectoryPage } from "./features/directory/components/DirectoryPage";
import { DownloadPage } from "./features/download/components/DownloadPage";

/** Shell with the top nav, for authenticated app pages. */
function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Nav />
      {children}
    </>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to={isLoggedIn() ? "/files" : "/login"} replace />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/account/change" element={<ChangePage />} />

      <Route
        path="/files"
        element={
          <RequireAuth>
            <AppShell>
              <FilesPage />
            </AppShell>
          </RequireAuth>
        }
      />
      <Route
        path="/admin"
        element={
          <RequireMaster>
            <AppShell>
              <AdminPage />
            </AppShell>
          </RequireMaster>
        }
      />
      <Route
        path="/api-docs"
        element={
          <AppShell>
            <ApiDocsPage />
          </AppShell>
        }
      />

      {/* Public share pages — no auth, no nav chrome by default */}
      <Route path="/d/:slug" element={<DirectoryPage />} />
      <Route path="/file/:slug" element={<DownloadPage />} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
