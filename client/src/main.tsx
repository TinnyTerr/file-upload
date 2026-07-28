import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/features/auth/hooks/auth";
import { UploadProvider } from "@/features/files/hooks/useUpload";
import { DialogProvider } from "@/providers/DialogProvider";
import { QueryProvider } from "@/providers/QueryProvider";
import { ToastProvider } from "@/providers/ToastProvider";
import App from "./App";
import "./index.css";

// Apply saved theme before first paint (avoids FOUC)
(function applyTheme() {
	const saved = localStorage.getItem("fu_theme") ?? "system";
	const root = document.documentElement;
	root.classList.remove("light", "dark");
	if (saved === "dark") root.classList.add("dark");
	else if (saved === "light") root.classList.add("light");
	else {
		// system: follow OS preference
		if (window.matchMedia("(prefers-color-scheme: dark)").matches)
			root.classList.add("dark");
	}
})();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<QueryProvider>
			<AuthProvider>
				<TooltipProvider delayDuration={200}>
					<DialogProvider>
						<UploadProvider>
							<BrowserRouter>
								<App />
							</BrowserRouter>
							<ToastProvider />
						</UploadProvider>
					</DialogProvider>
				</TooltipProvider>
			</AuthProvider>
		</QueryProvider>
	</StrictMode>,
);
