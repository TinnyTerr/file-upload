import { type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { csrf, isLoggedIn, logout as apiLogout, user, type User } from "../lib/api";

/** Current user snapshot from localStorage + login state. */
export function useAuth(): { user: User | null; loggedIn: boolean } {
  return { user: user.get(), loggedIn: isLoggedIn() };
}

export function useLogout(): () => Promise<void> {
  return async () => {
    await apiLogout();
    window.location.replace("/login");
  };
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const loc = useLocation();
  if (!csrf.get()) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

export function RequireMaster({ children }: { children: ReactNode }) {
  if (!csrf.get()) return <Navigate to="/login" replace />;
  const u = user.get();
  if (!u || u.role !== "master") return <Navigate to="/files" replace />;
  return <>{children}</>;
}
