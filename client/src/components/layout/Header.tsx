import { Menu } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetContent,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { UploadStatusIndicator } from "@/features/files/components/UploadStatusIndicator";
import { Brand } from "./Brand";
import { SidebarNav } from "./Sidebar";
import { UserMenu } from "./UserMenu";

export function Header() {
	const [mobileOpen, setMobileOpen] = useState(false);

	return (
		<header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border bg-background/70 px-4 backdrop-blur-lg">
			<div className="flex items-center gap-2">
				{/* Mobile nav trigger */}
				<Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
					<SheetTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="md:hidden"
							aria-label="Open menu"
						>
							<Menu />
						</Button>
					</SheetTrigger>
					<SheetContent side="left">
						<SheetTitle className="sr-only">Navigation</SheetTitle>
						<Brand />
						<div className="mt-4 flex flex-1 flex-col justify-between h-full">
							<div>
								<SidebarNav
									collapsed={false}
									onNavigate={() => setMobileOpen(false)}
								/>
							</div>
							<div className="mt-auto border-t border-border pt-4">
								<UserMenu />
							</div>
						</div>
					</SheetContent>
				</Sheet>
			</div>

			<div className="flex items-center gap-3">
				<UploadStatusIndicator />
			</div>
		</header>
	);
}
