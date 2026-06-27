import { Link, useLocation } from "react-router-dom";
import { useAuth, useLogout } from "../../features/auth/hooks/auth";
import { cn } from "../../lib/cn";
import { NAV_LINKS } from "../../config/navigation";

/** Brand wordmark with a small rotated "seal" diamond. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span className="grid h-6 w-6 place-items-center">
        <span className="block h-3 w-3 rotate-45 rounded-[3px] bg-gradient-to-br from-[var(--color-accent)] to-[var(--color-cyan)] shadow-[0_0_14px_var(--color-accent)]" />
      </span>
      <span className="font-[var(--font-display)] text-[15px] font-bold tracking-tight text-[var(--color-ink)]">
        Oxymoron
        <span className="ml-1 font-[var(--font-mono)] text-[11px] font-normal text-[var(--color-ink-muted)]">
          (for files)
        </span>
      </span>
    </span>
  );
}

export function Nav() {
  const { user } = useAuth();
  const logout = useLogout();
  const loc = useLocation();

  const links = NAV_LINKS.filter((l) => !l.master || user?.role === "master");

  return (
    <nav className="sticky top-0 z-50 border-b border-[var(--color-line)] bg-[color-mix(in_oklab,var(--color-canvas)_82%,transparent)] backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-1 px-6">
        <Link to="/files" className="mr-auto">
          <Wordmark />
        </Link>

        {user && (
          <span className="mr-2 hidden items-center gap-2 font-[var(--font-mono)] text-[13px] text-[var(--color-ink-dim)] sm:inline-flex">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-good)]" />
            {user.username}
          </span>
        )}

        {links.map((l) => {
          const active = loc.pathname.startsWith(l.match);
          return (
            <Link
              key={l.to}
              to={l.to}
              className={cn(
                "rounded-[8px] px-3 py-1.5 text-sm font-medium transition-colors",
                active
                  ? "text-[var(--color-ink)]"
                  : "text-[var(--color-ink-muted)] hover:text-[var(--color-ink-dim)]",
              )}
            >
              {l.label}
            </Link>
          );
        })}

        <button
          type="button"
          onClick={logout}
          className="rounded-[8px] px-3 py-1.5 text-sm font-medium text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-bad)]"
        >
          Sign out
        </button>
      </div>
    </nav>
  );
}
