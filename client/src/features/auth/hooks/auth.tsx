import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { accountService } from "@/features/account/services/accountService";
import { authService } from "../services/authService";
import { ApiError } from "@/config/api";
import type { CurrentUser } from "@/features/account/types";
import type { PermissionFlag } from "@/config/permissions";

interface AuthContextValue {
  user: CurrentUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  /** True if the session is valid but the account must change its credentials
   *  before it can do anything else — GET /account/me returns 403 in this state,
   *  so no CurrentUser is available yet. */
  mustChangeCredentials: boolean;
  /** True if the user has a permission. Masters implicitly have every permission. */
  can: (flag: PermissionFlag) => boolean;
  isMaster: boolean;
  refresh: () => Promise<unknown>;
  logout: () => Promise<void>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export const ME_QUERY_KEY = ["account", "me"] as const;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();

  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: accountService.me,
    retry: false,
    staleTime: 30_000,
    // 401 means "not logged in"; 403 means "logged in, but must change
    // credentials first" — both are expected states, not render-time errors.
    throwOnError: (err) => !(err instanceof ApiError && (err.status === 401 || err.status === 403)),
  });

  const logout = React.useCallback(async () => {
    await authService.logout();
    qc.clear();
    await refetch();
  }, [qc, refetch]);

  const value = React.useMemo<AuthContextValue>(() => {
    const user = data ?? null;
    const isMaster = user?.role === "master";
    const mustChangeCredentials = error instanceof ApiError && error.status === 403;
    return {
      user,
      isLoading,
      isAuthenticated: !!user || mustChangeCredentials,
      mustChangeCredentials,
      isMaster,
      can: (flag: PermissionFlag) => (user ? isMaster || !!user[flag] : false),
      refresh: refetch,
      logout,
    };
  }, [data, error, isLoading, refetch, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
