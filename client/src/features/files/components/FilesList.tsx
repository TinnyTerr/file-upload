import { FileQuestion } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { FileRow } from "./FileRow";
import { useFiles } from "../hooks/useFiles";

function ListSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-lg border border-border bg-secondary/20 p-3">
          <Skeleton className="size-9 rounded-md" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-8 w-16" />
        </div>
      ))}
    </div>
  );
}

export function FilesList() {
  const { data: files, isLoading, isError } = useFiles();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          Your files
          {files && files.length > 0 && (
            <span className="text-sm font-normal text-muted-foreground">{files.length}</span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <ListSkeleton />
        ) : isError ? (
          <EmptyState icon={FileQuestion} title="Couldn't load files" description="Try refreshing the page." />
        ) : !files || files.length === 0 ? (
          <EmptyState
            icon={FileQuestion}
            title="No files yet"
            description="Upload your first file above to get a shareable link."
          />
        ) : (
          <div className="space-y-2">
            {files.map((file) => (
              <FileRow key={file.id} file={file} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
