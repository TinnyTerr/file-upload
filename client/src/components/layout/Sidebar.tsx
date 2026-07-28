import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { NavLink } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { isFeatureEnabled } from "@/config/featureFlags";
import { NAV_ITEMS } from "@/config/navigation";
import { hasPermission } from "@/config/permissions";
import { useAuth } from "@/features/auth/hooks/auth";
import { cn } from "@/lib/cn";
import { Brand } from "./Brand";
import { UserMenu } from "./UserMenu";

export function SidebarNav({
	collapsed,
	onNavigate,
}: {
	collapsed: boolean;
	onNavigate?: () => void;
}) {
	const { user } = useAuth();
	const items = NAV_ITEMS.filter(
		(item) =>
			(!item.requires || hasPermission(user, item.requires)) &&
			(!item.feature || isFeatureEnabled(item.feature)),
	);

	return (
		<nav className="flex flex-col gap-1">
			{items.map((item) => {
				const link = (
					<NavLink
						key={item.to}
						to={item.to}
						onClick={onNavigate}
						className={({ isActive }) =>
							cn(
								"group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150",
								"hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
								"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
								isActive
									? "bg-sidebar-accent text-sidebar-accent-foreground"
									: "text-muted-foreground",
								collapsed && "justify-center px-0",
							)
						}
					>
						{({ isActive }) => (
							<>
								{isActive && (
									<span className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-brand-gradient" />
								)}
								<item.icon className="size-[18px] shrink-0" />
								{!collapsed && <span>{item.label}</span>}
							</>
						)}
					</NavLink>
				);
				return collapsed ? (
					<Tooltip key={item.to} content={item.label} side="right">
						{link}
					</Tooltip>
				) : (
					link
				);
			})}
		</nav>
	);
}

export function DesktopSidebar({
	collapsed,
	onToggle,
}: {
	collapsed: boolean;
	onToggle: () => void;
}) {
	const collapseBtn = (
		<Tooltip content={collapsed ? "Expand" : "Collapse"} side="right">
			<Button
				variant="ghost"
				size="icon"
				onClick={onToggle}
				className="shrink-0 text-muted-foreground hover:text-foreground"
				aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
			>
				{collapsed ? (
					<PanelLeftOpen className="size-[18px]" />
				) : (
					<PanelLeftClose className="size-[18px]" />
				)}
			</Button>
		</Tooltip>
	);

	return (
		<aside
			className={cn(
				"sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-3 transition-[width] duration-300 ease-out md:flex",
				collapsed ? "w-[72px]" : "w-60",
			)}
		>
			{/* Brand */}
			<div
				className={cn(
					"flex items-center px-1 py-2",
					collapsed ? "justify-center" : "justify-between",
				)}
			>
				<Brand collapsed={collapsed} />
			</div>

			{/* Nav */}
			<div className="mt-4 flex-1">
				<SidebarNav collapsed={collapsed} />
			</div>

			{/* Bottom bar */}
			<div className="mt-auto border-t border-sidebar-border pt-3">
				{collapsed ? (
					/* Collapsed: avatar centered, collapse below */
					<div className="flex flex-col items-center gap-1">
						<UserMenu collapsed={collapsed} />
						{collapseBtn}
					</div>
				) : (
					/* Expanded: [avatar + name] left, [collapse] right */
					<div className="flex items-center gap-1">
						<UserMenu collapsed={false} />
						{collapseBtn}
					</div>
				)}
			</div>
		</aside>
	);
}
