import { ApiKeysSection } from "./ApiKeysSection";

export function ApiKeysPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight">API Keys</h1>
        <p className="text-sm text-muted-foreground">Create and manage API keys for programmatic access.</p>
      </div>
      <ApiKeysSection />
    </div>
  );
}
