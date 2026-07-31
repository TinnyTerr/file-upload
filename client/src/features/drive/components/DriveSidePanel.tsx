import { Globe, Inbox } from "lucide-react";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ReceiveMode } from "@/features/files/components/modes/ReceiveMode";
import { RemoteMode } from "@/features/files/components/modes/RemoteMode";

const HINT: Record<string, string> = {
	remote: "Fetch a file from a URL and store it here.",
	receive: "Create a link other people can use to send you files.",
};

/** The two upload paths that aren't "pick files from this machine": pulling
 * from a URL, and handing someone else a dropbox link. Both are a different
 * mental model from the explorer, so they keep their own panel. */
export function DriveSidePanel() {
	const [mode, setMode] = useState("remote");

	return (
		<Card>
			<CardHeader>
				<CardTitle>Other ways in</CardTitle>
			</CardHeader>
			<CardContent>
				<Tabs defaultValue="remote" onValueChange={setMode}>
					<TabsList
						aria-label="Upload method"
						className="!grid w-full grid-cols-2"
					>
						<TabsTrigger value="remote" className="min-w-0">
							<Globe /> <span className="truncate">Remote</span>
						</TabsTrigger>
						<TabsTrigger value="receive" className="min-w-0">
							<Inbox /> <span className="truncate">Receive</span>
						</TabsTrigger>
					</TabsList>
					<p className="mt-2 text-xs text-muted-foreground">{HINT[mode]}</p>
					<TabsContent value="remote">
						<RemoteMode />
					</TabsContent>
					<TabsContent value="receive">
						<ReceiveMode />
					</TabsContent>
				</Tabs>
			</CardContent>
		</Card>
	);
}
