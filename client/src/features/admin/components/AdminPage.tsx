import {
	Files,
	HardDrive,
	Link2,
	ShieldCheck,
	ShieldX,
	Users,
} from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/features/auth/hooks/auth";
import { formatBytes } from "@/lib/bytes";
import { useDiskStats } from "../hooks/useAdminDashboard";
import { AuditTab } from "./AuditTab";
import { BackendTab } from "./BackendTab";
import { FilesTab } from "./FilesTab";
import { KeysTab } from "./KeysTab";
import { OverviewTab } from "./OverviewTab";
import { TorrentsTab } from "./TorrentsTab";
import { UsersTab } from "./UsersTab";

function StatCard({
	icon: Icon,
	label,
	value,
}: {
	icon: typeof Files;
	label: string;
	value: string;
}) {
	return (
		<Card>
			<CardContent className="flex items-center gap-3 p-4">
				<div className="flex size-10 items-center justify-center rounded-lg bg-secondary/50">
					<Icon className="size-5 text-primary" />
				</div>
				<div>
					<div className="text-xl font-bold">{value}</div>
					<div className="text-xs text-muted-foreground">{label}</div>
				</div>
			</CardContent>
		</Card>
	);
}

export function AdminPage() {
	const { isMaster, can } = useAuth();

	// Most admin endpoints are master-gated server-side; granular flags refine
	// visibility for non-master admins so the UI never shows tabs they can't use.
	const tabs = [
		{
			value: "overview",
			label: "Overview",
			el: <OverviewTab />,
			allowed: isMaster,
		},
		{
			value: "users",
			label: "Users",
			el: <UsersTab />,
			allowed: can("can_manage_users"),
		},
		{ value: "files", label: "Files", el: <FilesTab />, allowed: isMaster },
		{
			value: "keys",
			label: "API keys",
			el: <KeysTab />,
			allowed: can("can_manage_api_keys"),
		},
		{
			value: "torrents",
			label: "Torrents",
			el: <TorrentsTab />,
			allowed: isMaster,
		},
		{ value: "audit", label: "Audit", el: <AuditTab />, allowed: isMaster },
		{
			value: "backend",
			label: "Backend",
			el: <BackendTab />,
			allowed: isMaster,
		},
	].filter((t) => t.allowed);

	return (
		<div className="space-y-6">
			<PageHeader
				title="Admin"
				subtitle="Users, storage, audit and maintenance controls."
				icon={ShieldCheck}
			/>

			{isMaster && <HeaderStats />}

			{tabs.length === 0 ? (
				<EmptyState
					icon={ShieldX}
					title="No admin access"
					description="Your account can view the admin area but has no management permissions assigned."
				/>
			) : (
				<Tabs defaultValue={tabs[0].value}>
					<TabsList
						aria-label="Admin section"
						className="flex w-full flex-wrap"
					>
						{tabs.map((t) => (
							<TabsTrigger key={t.value} value={t.value}>
								{t.label}
							</TabsTrigger>
						))}
					</TabsList>
					{tabs.map((t) => (
						<TabsContent key={t.value} value={t.value}>
							{t.el}
						</TabsContent>
					))}
				</Tabs>
			)}
		</div>
	);
}

function HeaderStats() {
	const { data: stats, isLoading } = useDiskStats();
	if (isLoading || !stats) {
		return null;
	}
	return (
		<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
			<StatCard
				icon={Files}
				label="Files"
				value={stats.total_files.toLocaleString()}
			/>
			<StatCard
				icon={HardDrive}
				label="Stored"
				value={formatBytes(stats.total_bytes)}
			/>
			<StatCard
				icon={Users}
				label="Users"
				value={stats.total_users.toLocaleString()}
			/>
			<StatCard
				icon={Link2}
				label="Active links"
				value={stats.total_links.toLocaleString()}
			/>
		</div>
	);
}
