import { LogOut, Settings, User as UserIcon } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { accountService } from "@/features/account/services/accountService";
import { useAuth } from "@/features/auth/hooks/auth";
import { cn } from "@/lib/cn";
import { SettingsModal } from "./SettingsModal";

function Avatar({
	user,
	size = 7,
}: {
	user: { id: number; username: string; has_avatar?: boolean };
	size?: number;
}) {
	const cls = `flex size-${size} shrink-0 items-center justify-center rounded-full overflow-hidden`;
	if (user.has_avatar) {
		return (
			<span className={cls}>
				<img
					src={accountService.avatarUrl(user.id)}
					alt={user.username}
					className="size-full object-cover"
				/>
			</span>
		);
	}
	return (
		<span
			className={cn(
				cls,
				"bg-brand-gradient text-xs font-semibold text-primary-foreground",
			)}
		>
			{user.username.slice(0, 2).toUpperCase()}
		</span>
	);
}

export function UserMenu({ collapsed = false }: { collapsed?: boolean }) {
	const { user, logout } = useAuth();
	const navigate = useNavigate();
	const [settingsOpen, setSettingsOpen] = useState(false);

	const onLogout = async () => {
		await logout();
		navigate("/login", { replace: true });
	};

	if (!user) return null;

	const trigger = collapsed ? (
		<Button
			variant="ghost"
			size="icon"
			className="w-full justify-center"
			aria-label={`User menu for ${user.username}`}
		>
			<Avatar user={user} />
		</Button>
	) : (
		<Button
			variant="ghost"
			size="sm"
			className="min-w-0 flex-1 justify-start gap-2 px-2"
			aria-label={`User menu for ${user.username}`}
		>
			<Avatar user={user} />
			<span className="truncate text-sm font-medium">{user.username}</span>
		</Button>
	);

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
				<DropdownMenuContent
					align={collapsed ? "center" : "start"}
					side="top"
					className="w-56"
					sideOffset={8}
				>
					<DropdownMenuLabel
						className={cn(
							"flex items-center justify-between gap-2 normal-case",
							collapsed && "flex-col items-start gap-1",
						)}
					>
						<span className="flex items-center gap-2 text-sm font-medium text-foreground">
							<UserIcon className="size-4" /> {user.username}
						</span>
						<Badge variant={user.role === "master" ? "accent" : "secondary"}>
							{user.role}
						</Badge>
					</DropdownMenuLabel>
					<DropdownMenuSeparator />
					<DropdownMenuItem onClick={() => setSettingsOpen(true)}>
						<Settings /> Settings
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem destructive onClick={onLogout}>
						<LogOut /> Sign out
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

			<SettingsModal open={settingsOpen} onOpenChange={setSettingsOpen} />
		</>
	);
}
