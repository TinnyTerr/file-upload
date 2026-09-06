import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";

export type Theme = "system" | "light" | "dark";
type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "fu_theme";
// Matches index.css's --background for each theme, used for the browser
// chrome (address bar / task switcher), not anything inside the page itself.
const THEME_COLOR: Record<ResolvedTheme, string> = {
	dark: "#0a0a0f",
	light: "#f7f7f5",
};

function systemPrefersDark(): boolean {
	return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolve(theme: Theme): ResolvedTheme {
	return theme === "system" ? (systemPrefersDark() ? "dark" : "light") : theme;
}

function applyResolved(resolved: ResolvedTheme) {
	const root = document.documentElement;
	root.classList.remove("light", "dark");
	root.classList.add(resolved);
	root.style.colorScheme = resolved;
	document
		.querySelector('meta[name="theme-color"]')
		?.setAttribute("content", THEME_COLOR[resolved]);
	document
		.querySelector('meta[name="color-scheme"]')
		?.setAttribute("content", resolved);
}

interface ThemeContextValue {
	theme: Theme;
	resolvedTheme: ResolvedTheme;
	setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * The one place theme state lives. `main.tsx` applies the saved theme's class
 * synchronously before the first paint (there's no time to wait for this
 * provider to mount), so the work here is idempotent with that -- it's the
 * ongoing reactive owner: live system-theme changes, the meta tags, and
 * everything that reads or sets the theme after mount.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
	const [theme, setThemeState] = useState<Theme>(
		() => (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? "system",
	);
	const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
		resolve(theme),
	);

	const setTheme = useCallback((next: Theme) => {
		localStorage.setItem(STORAGE_KEY, next);
		setThemeState(next);
	}, []);

	useEffect(() => {
		const resolved = resolve(theme);
		setResolvedTheme(resolved);
		applyResolved(resolved);

		if (theme !== "system") return;
		// "System" tracks the OS live -- switching light/dark while the tab is
		// open must not need a reload or a re-visit to the Preferences tab.
		const mql = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = () => {
			const next = mql.matches ? "dark" : "light";
			setResolvedTheme(next);
			applyResolved(next);
		};
		mql.addEventListener("change", onChange);
		return () => mql.removeEventListener("change", onChange);
	}, [theme]);

	return (
		<ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
			{children}
		</ThemeContext.Provider>
	);
}

export function useTheme() {
	const ctx = useContext(ThemeContext);
	if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
	return ctx;
}
