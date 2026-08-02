import {
	Navigate,
	Outlet,
	useLocation,
	useSearchParams,
} from "react-router-dom";
import { useAuth } from "@/features/auth/hooks/auth";
import { safeInternalPath } from "@/lib/redirect";
import { FullPageSpinner } from "./FullPageSpinner";

export const MFA_SETUP_PATH = "/account/mfa-setup";

/** Requires a logged-in user; redirects unauthenticated users to /login.
 *  Forces the credential-change flow when the account demands it, and the MFA
 *  enrollment flow when `require_mfa`/`require_passkey` is unmet. */
export function RequireAuth() {
	const { user, isLoading, mustChangeCredentials, mfaEnrollmentRequired } =
		useAuth();
	const location = useLocation();

	if (isLoading) return <FullPageSpinner />;
	if (mfaEnrollmentRequired) {
		return location.pathname === MFA_SETUP_PATH ? (
			<Outlet />
		) : (
			<Navigate to={MFA_SETUP_PATH} replace />
		);
	}
	if (mustChangeCredentials) {
		return location.pathname === "/account/change" ? (
			<Outlet />
		) : (
			<Navigate to="/account/change" replace />
		);
	}
	if (!user)
		return <Navigate to="/login" replace state={{ from: location.pathname }} />;
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
export function RequirePermission({
	flag,
}: {
	flag: import("@/config/permissions").PermissionFlag;
}) {
	const { user, isLoading, can } = useAuth();
	if (isLoading) return <FullPageSpinner />;
	if (!user) return <Navigate to="/login" replace />;
	if (!can(flag)) return <Navigate to="/files" replace />;
	return <Outlet />;
}

/** Sends already-authenticated users away from public-only pages (e.g. login).
 * Honours `?next=<path>` so a flow interrupted by the login screen -- the OAuth
 * consent page is the one that needs it -- resumes where it left off. */
export function RedirectIfAuthed({ children }: { children: React.ReactNode }) {
	const { user, isLoading, mustChangeCredentials, mfaEnrollmentRequired } =
		useAuth();
	const [params] = useSearchParams();
	if (isLoading) return <FullPageSpinner />;
	if (mfaEnrollmentRequired) return <Navigate to={MFA_SETUP_PATH} replace />;
	if (mustChangeCredentials) return <Navigate to="/account/change" replace />;
	if (user)
		return (
			<Navigate to={safeInternalPath(params.get("next")) ?? "/files"} replace />
		);
	return <>{children}</>;
}
