import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { RootErrorBoundary } from "@/components/layout/RootErrorBoundary";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/features/auth/hooks/auth";
import { RevealedKeyProvider } from "@/features/drive/hooks/useRevealedKeys";
import { UploadProvider } from "@/features/files/hooks/useUpload";
import { initSentry } from "@/lib/sentry";
import { DialogProvider } from "@/providers/DialogProvider";
import { QueryProvider } from "@/providers/QueryProvider";
import { ThemeProvider } from "@/providers/ThemeProvider";
import { ToastProvider } from "@/providers/ToastProvider";
import App from "./App";
import "./index.css";

initSentry();

// Apply saved theme before first paint (avoids FOUC). `ThemeProvider` is the
// ongoing reactive owner once mounted; this only has to get the very first
// frame right, so it duplicates rather than imports that logic.
(function applyTheme() {
	const saved = localStorage.getItem("fu_theme") ?? "system";
	const dark =
		saved === "dark" ||
		(saved !== "light" &&
			window.matchMedia("(prefers-color-scheme: dark)").matches);
	const root = document.documentElement;
	root.classList.remove("light", "dark");
	root.classList.add(dark ? "dark" : "light");
})();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		{/* Outermost on purpose: a provider that throws while mounting must still
		    reach a rendered error page, not a blank document. */}
		<RootErrorBoundary>
			<ThemeProvider>
				<QueryProvider>
					<AuthProvider>
						<TooltipProvider delayDuration={200}>
							<DialogProvider>
								<UploadProvider>
									{/* Above the router on purpose: a revealed key must survive the
									    refetch, the navigation and the reload that the mutation
									    producing it can trigger. */}
									<RevealedKeyProvider>
										<BrowserRouter>
											<App />
										</BrowserRouter>
										<ToastProvider />
									</RevealedKeyProvider>
								</UploadProvider>
							</DialogProvider>
						</TooltipProvider>
					</AuthProvider>
				</QueryProvider>
			</ThemeProvider>
		</RootErrorBoundary>
	</StrictMode>,
);
