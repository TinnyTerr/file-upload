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

  const { data, isLoading, refetch } = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: accountService.me,
    retry: false,
    staleTime: 30_000,
    // A 401 simply means "not logged in" — treat as null, not an error.
    throwOnError: (err) => !(err instanceof ApiError && err.status === 401),
  });

  const logout = React.useCallback(async () => {
    await authService.logout();
    qc.clear();
    await refetch();
  }, [qc, refetch]);

  const value = React.useMemo<AuthContextValue>(() => {
    const user = data ?? null;
    const isMaster = user?.role === "master";
    return {
      user,
      isLoading,
      isAuthenticated: !!user,
      isMaster,
      can: (flag: PermissionFlag) => (user ? isMaster || !!user[flag] : false),
      refresh: refetch,
      logout,
    };
  }, [data, isLoading, refetch, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
