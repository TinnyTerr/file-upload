import { useMemo } from "react";
import { BookText, KeyRound, Upload, Download, Info, FolderTree, ShieldCheck, AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg border border-border bg-background/50 p-3 pr-12 font-mono text-xs leading-relaxed">
        {code}
      </pre>
      <div className="absolute right-2 top-2">
        <CopyButton value={code} />
      </div>
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  id,
  endpoint,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  id: string;
  endpoint?: string;
  children: React.ReactNode;
}) {
  return (
    <Card id={id} className="scroll-mt-20">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Icon className="size-4 text-primary" aria-hidden="true" />
          <span>{title}</span>
          {endpoint && (
            <code className="rounded-md border border-border bg-secondary/60 px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {endpoint}
            </code>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">{children}</CardContent>
    </Card>
  );
}

export function ApiDocsPage() {
  const origin = useMemo(() => window.location.origin, []);
  const sections = [
    { id: "authentication", label: "Authentication" },
    { id: "upload", label: "Upload" },
    { id: "download", label: "Download" },
    { id: "metadata", label: "Metadata" },
    { id: "folders", label: "Folders" },
    { id: "encryption", label: "Encryption" },
    { id: "errors", label: "Errors" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-brand-gradient shadow-lg shadow-primary/20">
          <BookText className="size-5 text-primary-foreground" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">API reference</h1>
          <p className="text-sm text-muted-foreground">Upload and download programmatically.</p>
        </div>
      </div>

      <nav aria-label="API sections" className="flex flex-wrap gap-2 rounded-lg border border-border bg-secondary/20 p-2">
        {sections.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {section.label}
          </a>
        ))}
      </nav>

      <Section id="authentication" icon={KeyRound} title="Authentication" endpoint="Bearer token">
        <p>
          Programmatic requests authenticate with a personal API key using a Bearer header. Create keys from the Files
          page (requires the API-keys permission).
        </p>
        <CodeBlock code={`Authorization: Bearer <your-api-key>`} />
        <p>Keys bind to the first IP that uses them; reset the binding from the Files page to use a new IP.</p>
      </Section>

      <Section id="upload" icon={Upload} title="Upload a file" endpoint="POST /files/upload">
        <p>Send a multipart form to the upload endpoint. The response includes a shareable link.</p>
        <CodeBlock
          code={`curl -X POST "${origin}/files/upload" \\
  -H "Authorization: Bearer <your-api-key>" \\
  -F "file=@./report.pdf" \\
  -F "original_filename=report.pdf" \\
  -F "encryption_mode=none"`}
        />
        <p>
          Options: <code>encryption_mode</code> (none|server|client), <code>max_uses</code>,{" "}
          <code>expires_in_seconds</code>, <code>compress</code>, <code>randomize_filename</code>.
        </p>
      </Section>

      <Section id="download" icon={Download} title="Download" endpoint="GET /file/{slug}/raw">
        <CodeBlock code={`curl -L -O "${origin}/file/<slug>/raw"`} />
        <p>
          Server-encrypted files require the access key: <code>{`${origin}/file/<slug>/raw?ek=<access_key>`}</code>.
          End-to-end files return ciphertext — decrypt locally with the <code>#ek=</code> key.
        </p>
      </Section>

      <Section id="metadata" icon={Info} title="File metadata" endpoint="GET /file/{slug}/info">
        <p>Fetch metadata without consuming a download:</p>
        <CodeBlock code={`curl "${origin}/file/<slug>/info"`} />
      </Section>

      <Section id="folders" icon={FolderTree} title="Folders" endpoint="GET /d/{slug}/zip">
        <p>Download an entire folder as a ZIP (server streams it for unencrypted / server-encrypted folders):</p>
        <CodeBlock code={`curl -L -O "${origin}/d/<slug>/zip"`} />
      </Section>

      <Section id="encryption" icon={ShieldCheck} title="Encryption modes">
        <ul className="ml-4 list-disc space-y-1">
          <li>
            <strong className="text-foreground">none</strong> — the link is the only credential.
          </li>
          <li>
            <strong className="text-foreground">server</strong> — a <code>?ek=</code> key gates download; the server
            decrypts before streaming.
          </li>
          <li>
            <strong className="text-foreground">client</strong> — end-to-end; the <code>#ek=</code> key never leaves the
            browser and the server cannot decrypt.
          </li>
        </ul>
      </Section>

      <Section id="errors" icon={AlertCircle} title="Errors">
        <p>Errors return JSON as {`{ "detail": "<message>" }`}. Common statuses:</p>
        <ul className="ml-4 list-disc space-y-1">
          <li>
            <code>401</code> — not authenticated / missing access key
          </li>
          <li>
            <code>403</code> — not permitted
          </li>
          <li>
            <code>404</code> — unknown / expired / exhausted link
          </li>
          <li>
            <code>413</code> — exceeds quota or per-file size limit
          </li>
          <li>
            <code>429</code> — rate-limited
          </li>
        </ul>
      </Section>
    </div>
  );
}
