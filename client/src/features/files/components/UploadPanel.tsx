import { useState } from "react";
import { Files, FolderUp, Globe, Inbox } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { FilesMode } from "./modes/FilesMode";
import { FolderMode } from "./modes/FolderMode";
import { RemoteMode } from "./modes/RemoteMode";
import { ReceiveMode } from "./modes/ReceiveMode";

const MODE_HINT: Record<string, string> = {
  files: "Upload one or more individual files — each gets its own share link.",
  folder: "Upload a whole folder (with its files) as a single shareable bundle.",
  remote: "Fetch a file from a URL and store it here.",
  receive: "Create a link other people can use to send you files.",
};

export function UploadPanel() {
  const [mode, setMode] = useState("files");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="files" onValueChange={setMode}>
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
          <p className="mt-2 text-xs text-muted-foreground">{MODE_HINT[mode]}</p>

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
