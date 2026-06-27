import { Navigate, Route, Routes } from "react-router-dom";
import { isLoggedIn } from "./lib/api";
import { RequireAuth, RequireMaster } from "./auth/auth";
import { Nav } from "./components/Nav";
import { LoginPage } from "./pages/LoginPage";
import { ChangePage } from "./pages/ChangePage";
import { FilesPage } from "./pages/FilesPage";
import { AdminPage } from "./pages/AdminPage";
import { ApiDocsPage } from "./pages/ApiDocsPage";
import { DirectoryPage } from "./pages/DirectoryPage";
import { DownloadPage } from "./pages/DownloadPage";

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
