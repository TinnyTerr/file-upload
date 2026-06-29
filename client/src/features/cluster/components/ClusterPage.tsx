import { useState } from "react";
import { Network, Server, Plus, Trash2, RotateCcw, Eye, ShieldCheck, Radio } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { CopyButton } from "@/components/ui/copy-button";
import { useClusterNodes, useClusterToken } from "../hooks/useCluster";
import { useDialogs } from "@/providers/DialogProvider";
import { formatDate, relativeTime } from "@/lib/time";

function LocalTokenCard() {
  const { reveal, rotate } = useClusterToken();
  const { confirm } = useDialogs();
  const [token, setToken] = useState<string | null>(null);

  const onReveal = async () => setToken(await reveal.mutateAsync());

  const onRotate = async () => {
    const ok = await confirm({
      title: "Rotate cluster token?",
      description:
        "The current token stops working immediately. Every node and monitor subscribed to this server's firehose must be updated with the new token.",
      confirmText: "Rotate",
      destructive: true,
    });
    if (ok) setToken(await rotate.mutateAsync());
  };

  return (
    <Card className="border-destructive/30 bg-destructive/5">
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-destructive" />
            This server's cluster token
          </CardTitle>
          <CardDescription>
            Hand this token to another node so it can subscribe to our event firehose. It grants read
            access to <strong>every</strong> event on this server — treat it like a root credential.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {token ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-background/50 p-3">
            <code className="min-w-0 flex-1 truncate font-mono text-sm">{token}</code>
            <CopyButton value={token} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            The token is hidden. Reveal it to copy, or rotate to generate a fresh one.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onReveal} loading={reveal.isPending}>
            <Eye /> Reveal token
          </Button>
          <Button variant="outline" size="sm" className="text-destructive" onClick={onRotate} loading={rotate.isPending}>
            <RotateCcw /> Rotate token
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function LinkNodeForm({ onDone }: { onDone: () => void }) {
  const { link } = useClusterNodes();
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !baseUrl.trim() || !token.trim()) return;
    await link.mutateAsync({ name: name.trim(), base_url: baseUrl.trim(), token: token.trim() });
    setName("");
    setBaseUrl("");
    setToken("");
    onDone();
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-border bg-secondary/20 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="node-name">Name</Label>
          <Input id="node-name" placeholder="eu-west-1" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="node-url">Base URL</Label>
          <Input
            id="node-url"
            placeholder="https://node.example.com"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="node-token">Remote cluster token</Label>
        <Input
          id="node-token"
          type="password"
          placeholder="The other server's cluster token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="font-mono"
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" loading={link.isPending}>
          Link node
        </Button>
      </div>
    </form>
  );
}

function LinkedNodesCard() {
  const { list, unlink } = useClusterNodes();
  const { confirm } = useDialogs();
  const [adding, setAdding] = useState(false);

  const onUnlink = async (id: number, name: string) => {
    const ok = await confirm({
      title: "Unlink node?",
      description: `This server will stop trusting ${name}'s token. You can re-link it later.`,
      confirmText: "Unlink",
      destructive: true,
    });
    if (ok) unlink.mutate(id);
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle>Linked nodes</CardTitle>
          <CardDescription>
            Remote servers this node connects to. Paste another server's base URL and cluster token to link it.
          </CardDescription>
        </div>
        {!adding && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus /> Link node
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {adding && <LinkNodeForm onDone={() => setAdding(false)} />}
        {list.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : !list.data || list.data.length === 0 ? (
          !adding && (
            <EmptyState
              icon={Server}
              title="No linked nodes"
              description="Link another server to receive its event firehose."
            />
          )
        ) : (
          <ul className="space-y-2">
            {list.data.map((node) => (
              <li
                key={node.id}
                className="flex items-center gap-3 rounded-lg border border-border bg-secondary/20 p-3"
              >
                <Server className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{node.name}</span>
                    {node.active ? (
                      <Badge variant="success">active</Badge>
                    ) : (
                      <Badge variant="secondary">inactive</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {node.base_url} · token {node.token_preview}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground/70">
                    Linked {node.created_at ? formatDate(node.created_at) : "—"} · last seen{" "}
                    {relativeTime(node.last_seen_at)}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-destructive"
                  onClick={() => onUnlink(node.id, node.name)}
                  aria-label={`Unlink node ${node.name}`}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ConnectingInfoCard() {
  const origin = window.location.origin;
  const wsOrigin = origin.replace(/^http/, "ws");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Radio className="size-4 text-primary" />
          Connecting nodes
        </CardTitle>
        <CardDescription>
          A linked node authenticates with the remote server's cluster token, then streams or polls its events.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm text-muted-foreground">
        <div className="space-y-1.5">
          <p className="font-medium text-foreground">Event firehose (WebSocket)</p>
          <p>Streams every event on the remote server. Pass the cluster token as <code>?token=</code> or a Bearer header.</p>
          <CodeLine value={`${wsOrigin}/admin/cluster/firehose?token=<cluster-token>`} />
        </div>
        <div className="space-y-1.5">
          <p className="font-medium text-foreground">Poll events (HTTP)</p>
          <p>
            A websocket-free alternative. Pass the highest <code>id</code> seen as <code>?after=</code> to replay only
            what you missed.
          </p>
          <CodeLine value={`${origin}/admin/cluster/events?after=0`} />
        </div>
      </CardContent>
    </Card>
  );
}

function CodeLine({ value }: { value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-background/50 p-2.5">
      <code className="min-w-0 flex-1 truncate font-mono text-xs">{value}</code>
      <CopyButton value={value} />
    </div>
  );
}

export function ClusterPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-brand-gradient shadow-lg shadow-primary/20">
          <Network className="size-5 text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Cluster</h1>
          <p className="text-sm text-muted-foreground">Link this server to other nodes and manage cluster tokens.</p>
        </div>
      </div>

      <LocalTokenCard />
      <LinkedNodesCard />
      <ConnectingInfoCard />
    </div>
  );
}
