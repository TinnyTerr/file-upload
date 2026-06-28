import { Files, FolderUp, Globe, Inbox } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { FilesMode } from "./modes/FilesMode";
import { FolderMode } from "./modes/FolderMode";
import { RemoteMode } from "./modes/RemoteMode";
import { ReceiveMode } from "./modes/ReceiveMode";

export function UploadPanel() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="files">
          <TabsList aria-label="Upload method" className="!grid w-full grid-cols-2 sm:grid-cols-4">
            <TabsTrigger value="files" className="min-w-0">
              <Files /> <span className="truncate">Files</span>
            </TabsTrigger>
            <TabsTrigger value="folder" className="min-w-0">
              <FolderUp /> <span className="truncate">Folder</span>
            </TabsTrigger>
            <TabsTrigger value="remote" className="min-w-0">
              <Globe /> <span className="truncate">Remote</span>
            </TabsTrigger>
            <TabsTrigger value="receive" className="min-w-0">
              <Inbox /> <span className="truncate">Receive</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="files">
            <FilesMode />
          </TabsContent>
          <TabsContent value="folder">
            <FolderMode />
          </TabsContent>
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
