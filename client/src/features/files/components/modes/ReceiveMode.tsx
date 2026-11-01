import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DropboxManager } from "@/features/dropbox/components/DropboxManager";
import { PersistentDropboxes } from "@/features/dropbox/components/PersistentDropboxes";

export function ReceiveMode() {
	return (
		<Tabs defaultValue="persistent" className="space-y-4">
			<TabsList>
				<TabsTrigger value="persistent">Dropboxes</TabsTrigger>
				<TabsTrigger value="once">One-time link</TabsTrigger>
			</TabsList>
			<TabsContent value="persistent">
				<PersistentDropboxes />
			</TabsContent>
			<TabsContent value="once">
				<DropboxManager />
			</TabsContent>
		</Tabs>
	);
}
