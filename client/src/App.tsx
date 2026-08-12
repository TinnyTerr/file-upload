import { lazy, type ReactNode, Suspense } from "react";
import { Navigate, Route, Routes, useSearchParams } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { FeatureUnavailable } from "@/components/layout/FeatureUnavailable";
import { FullPageSpinner } from "@/components/layout/FullPageSpinner";
import {
	MFA_SETUP_PATH,
	RedirectIfAuthed,
	RequireAuth,
	RequireMaster,
	RequirePermission,
} from "@/components/layout/guards";
import { NotFoundPage } from "@/components/layout/NotFoundPage";
import { PublicShell } from "@/components/layout/PublicShell";
import { type FeatureFlag, isFeatureEnabled } from "@/config/featureFlags";
import { ChangePage } from "@/features/auth/components/ChangePage";

import { LoginPage } from "@/features/auth/components/LoginPage";
import { useAuth } from "@/features/auth/hooks/auth";

const ExplorerPage = lazy(() =>
	import("@/features/drive/components/explorer/ExplorerPage").then((m) => ({
		default: m.ExplorerPage,
	})),
);
const DownloadPage = lazy(() =>
	import("@/features/download/components/DownloadPage").then((m) => ({
		default: m.DownloadPage,
	})),
);
const FolderPage = lazy(() =>
	import("@/features/folder-view/components/FolderPage").then((m) => ({
		default: m.FolderPage,
	})),
);
const ApiDocsPage = lazy(() =>
	import("@/features/api-docs/components/ApiDocsPage").then((m) => ({
		default: m.ApiDocsPage,
	})),
);
const DropboxUploadPage = lazy(() =>
	import("@/features/dropbox/components/DropboxUploadPage").then((m) => ({
		default: m.DropboxUploadPage,
	})),
);
const AdminPage = lazy(() =>
	import("@/features/admin/components/AdminPage").then((m) => ({
		default: m.AdminPage,
	})),
);
const ApiKeysPage = lazy(() =>
	import("@/features/apikeys/components/ApiKeysPage").then((m) => ({
		default: m.ApiKeysPage,
	})),
);
const TorrentsPage = lazy(() =>
	import("@/features/torrents/components/TorrentsPage").then((m) => ({
		default: m.TorrentsPage,
	})),
);
const WatchLayout = lazy(() =>
	import("@/features/media/components/WatchLayout").then((m) => ({
		default: m.WatchLayout,
	})),
);
const MediaPage = lazy(() =>
	import("@/features/media/components/MediaPage").then((m) => ({
		default: m.MediaPage,
	})),
);
const CollectionPage = lazy(() =>
	import("@/features/media/components/CollectionPage").then((m) => ({
		default: m.CollectionPage,
	})),
);
const MfaSetupPage = lazy(() =>
	import("@/features/account/components/MfaSetupPage").then((m) => ({
		default: m.MfaSetupPage,
	})),
);
const AuthorizePage = lazy(() =>
	import("@/features/oauth/components/AuthorizePage").then((m) => ({
		default: m.AuthorizePage,
	})),
);
const ClusterPage = lazy(() =>
	import("@/features/cluster/components/ClusterPage").then((m) => ({
		default: m.ClusterPage,
	})),
);

/** Renders `children` if the backend feature has been ported, otherwise a placeholder. */
function Gated({
	feature,
	label,
	children,
}: {
	feature: FeatureFlag;
	label: string;
	children: ReactNode;
}) {
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

				{/* OAuth consent. Deliberately outside AppShell: it is a decision
				    screen for a third-party app, not a page of this app, and it
				    handles its own signed-out case (bouncing through /login?next=
				    so the request's query string survives the round trip). */}
				<Route path="/oauth/authorize" element={<AuthorizePage />} />

				{/* The media library: its own layout, because public collections have
				    to render for signed-out visitors while signed-in users still get
				    the app chrome. Per-collection entitlement is enforced server-side. */}
				<Route
					path="/watch"
					element={
						<Gated feature="media" label="Media library">
							<WatchLayout />
						</Gated>
					}
				>
					<Route index element={<MediaPage />} />
					<Route path=":slug" element={<CollectionPage />} />
				</Route>

				{/* App chrome layout — all children require auth */}
				<Route element={<AppShell />}>
					<Route element={<RequireAuth />}>
						{/* The explorer keeps the open folder in the URL, so `/files`
						    and `/files/:dirId` are the same page at different depths. */}
						<Route
							path="/files"
							element={
								<Gated feature="files" label="Files">
									<ExplorerPage />
								</Gated>
							}
						/>
						<Route
							path="/files/:dirId"
							element={
								<Gated feature="files" label="Files">
									<ExplorerPage />
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
						<Route
							path={MFA_SETUP_PATH}
							element={
								<Gated feature="account" label="Account settings">
									<MfaSetupPage />
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
				{/* Unknown address: say so, rather than bouncing to `/` and making a
				    dead link look like a normal visit. The server hands the shell to
				    any extension-less path, so this is where those land. */}
				<Route
					path="*"
					element={
						<PublicShell>
							<NotFoundPage />
						</PublicShell>
					}
				/>
			</Routes>
		</Suspense>
	);
}
