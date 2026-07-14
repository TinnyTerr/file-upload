import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "@/features/auth/hooks/auth";
import { FullPageSpinner } from "./FullPageSpinner";

/** Requires a logged-in user; redirects unauthenticated users to /login.
 *  Forces the credential-change flow when the account demands it. */
export function RequireAuth() {
  const { user, isLoading, mustChangeCredentials } = useAuth();
  const location = useLocation();

  if (isLoading) return <FullPageSpinner />;
  if (mustChangeCredentials) {
    return location.pathname === "/account/change" ? (
      <Outlet />
    ) : (
      <Navigate to="/account/change" replace />
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.must_change_credentials && location.pathname !== "/account/change") {
    return <Navigate to="/account/change" replace />;
  }
  return <Outlet />;
}

/** Requires admin access (master role / can_view_admin). */
export function RequireMaster() {
  const { user, isLoading, can } = useAuth();
  if (isLoading) return <FullPageSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  if (!can("can_view_admin")) return <Navigate to="/files" replace />;
  return <Outlet />;
}

/** Requires a specific permission; redirects to /files otherwise. */
export function RequirePermission({ flag }: { flag: import("@/config/permissions").PermissionFlag }) {
  const { user, isLoading, can } = useAuth();
  if (isLoading) return <FullPageSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  if (!can(flag)) return <Navigate to="/files" replace />;
  return <Outlet />;
}

/** Sends already-authenticated users away from public-only pages (e.g. login). */
export function RedirectIfAuthed({ children }: { children: React.ReactNode }) {
  const { user, isLoading, mustChangeCredentials } = useAuth();
  if (isLoading) return <FullPageSpinner />;
  if (mustChangeCredentials) return <Navigate to="/account/change" replace />;
  if (user) return <Navigate to="/files" replace />;
  return <>{children}</>;
}
