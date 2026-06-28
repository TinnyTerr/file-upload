import { UsageMeter } from "./UsageMeter";
import { UploadPanel } from "./UploadPanel";
import { FilesList } from "./FilesList";
import { FoldersList } from "@/features/directories/components/FoldersList";
import { ApiKeysSection } from "@/features/apikeys/components/ApiKeysSection";
import { useAuth } from "@/features/auth/hooks/auth";

export function FilesPage() {
  const { can } = useAuth();
  const canUpload = can("can_upload");

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight">Your files</h1>
        <p className="text-sm text-muted-foreground">Upload, manage, and share files with links you control.</p>
      </div>

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="order-2 min-w-0 space-y-6 lg:order-1">
          {canUpload && <UploadPanel />}
          <FoldersList />
          <FilesList />
          <ApiKeysSection />
        </div>
        <div className="order-1 min-w-0 space-y-6 lg:order-2">
          <UsageMeter />
        </div>
      </div>
    </div>
  );
}
