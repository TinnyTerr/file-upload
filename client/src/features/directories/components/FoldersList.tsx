import { FolderOpen } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { FolderRow } from "./FolderRow";
import { CreateFolderDialog } from "./CreateFolderDialog";
import { useDirectories } from "../hooks/useDirectories";
import { useAuth } from "@/features/auth/hooks/auth";

export function FoldersList() {
  const { data: dirs, isLoading } = useDirectories();
  const { can } = useAuth();
  const canCreate = can("can_create_directories");

  // Hide the card entirely only for users who can't create folders and have none.
  if (!isLoading && !canCreate && (!dirs || dirs.length === 0)) return null;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2">
          Folders
          {dirs && dirs.length > 0 && <span className="text-sm font-normal text-muted-foreground">{dirs.length}</span>}
        </CardTitle>
        {canCreate && <CreateFolderDialog />}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : !dirs || dirs.length === 0 ? (
          <EmptyState
            icon={FolderOpen}
            title="No folders yet"
            description="Create an empty folder or upload one from the panel above."
            action={canCreate ? <CreateFolderDialog /> : undefined}
          />
        ) : (
          <div className="space-y-2">
            {dirs.map((dir) => (
              <FolderRow key={dir.id} dir={dir} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
