import { useState } from "react";
import { KeyRound, Plus, RotateCcw, Trash2, Globe, Lock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Tooltip } from "@/components/ui/tooltip";
import { NewKeyModal } from "./NewKeyModal";
import { useApiKeys } from "../hooks/useApiKeys";
import { useDialogs } from "@/providers/DialogProvider";
import { useAuth } from "@/features/auth/hooks/auth";
import { formatDate, relativeTime } from "@/lib/time";
import type { NewApiKey } from "../types";

export function ApiKeysSection() {
  const { can } = useAuth();
  const { list, create, deleteKey, resetIp } = useApiKeys();
  const { confirm, prompt } = useDialogs();
  const [newKey, setNewKey] = useState<NewApiKey | null>(null);

  if (!can("can_use_api_keys")) return null;

  const onCreate = async () => {
    const created = await create.mutateAsync();
    setNewKey(created);
  };

  const onDelete = async (id: number) => {
    const ok = await confirm({
      title: "Delete API key?",
      description: "Programs using this key will stop working immediately, and the key will be removed from the list.",
      confirmText: "Delete",
      destructive: true,
    });
    if (ok) deleteKey.mutate(id);
  };

  const onResetIp = async (id: number) => {
    const password = await prompt({
      title: "Reset IP binding",
      description: "Confirm your password to allow this key from a new IP.",
      label: "Password",
      inputType: "password",
      confirmText: "Reset",
    });
    if (password) resetIp.mutate({ keyId: id, password });
  };

  return (
    <>
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <div>
            <CardTitle>API keys</CardTitle>
            <CardDescription>For programmatic uploads via Bearer auth.</CardDescription>
          </div>
          <Button size="sm" onClick={onCreate} loading={create.isPending}>
            <Plus /> New key
          </Button>
        </CardHeader>
        <CardContent>
          {list.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : !list.data || list.data.length === 0 ? (
            <EmptyState icon={KeyRound} title="No API keys" description="Create one to upload from scripts or the CLI." />
          ) : (
            <ul className="space-y-2">
              {list.data.map((key) => (
                <li key={key.id} className="flex items-center gap-3 rounded-lg border border-border bg-secondary/20 p-3">
                  <KeyRound className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">Key #{key.user_key_number}</span>
                      {key.active ? (
                        <Badge variant="success">active</Badge>
                      ) : (
                        <Badge variant="secondary">inactive</Badge>
                      )}
                      {key.bound_ip ? (
                        <Tooltip content={`Bound to ${key.bound_ip}`}>
                          <Badge variant="accent">
                            <Lock /> bound
                          </Badge>
                        </Tooltip>
                      ) : (
                        <Badge variant="secondary">
                          <Globe /> unbound
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Created {formatDate(key.created_at)} · last used {relativeTime(key.last_used_at)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    {key.active && (
                      <Tooltip content="Reset IP binding">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onResetIp(key.id)}
                          aria-label={`Reset IP binding for API key ${key.user_key_number}`}
                        >
                          <RotateCcw />
                        </Button>
                      </Tooltip>
                    )}
                    <Tooltip content="Delete key">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive"
                        onClick={() => onDelete(key.id)}
                        aria-label={`Delete API key ${key.user_key_number}`}
                      >
                        <Trash2 />
                      </Button>
                    </Tooltip>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <NewKeyModal apiKey={newKey} onClose={() => setNewKey(null)} />
    </>
  );
}
