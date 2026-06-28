import { useState, useEffect } from "react";
import { Outlet } from "react-router-dom";
import { DesktopSidebar } from "./Sidebar";
import { Header } from "./Header";

const COLLAPSE_KEY = "fu_sidebar_collapsed";

/** Authenticated layout: collapsible sidebar + sticky header + routed content. */
export function AppShell() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === "1");

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  return (
    <div className="flex min-h-dvh">
      <DesktopSidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
