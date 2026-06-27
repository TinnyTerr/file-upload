import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "../../../lib/cn";
import { Container, Eyebrow, CopyButton } from "../../../components/ui/primitives";

const SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "auth", label: "Authentication" },
  { id: "upload", label: "Upload a file" },
  { id: "download", label: "Download" },
  { id: "info", label: "File metadata" },
  { id: "folders", label: "Folders" },
  { id: "encryption", label: "Encryption" },
  { id: "errors", label: "Errors" },
];

type Method = "GET" | "POST" | "DEL";
const METHOD_TONE: Record<Method, string> = {
  GET: "bg-[var(--color-good-soft)] text-[var(--color-good)]",
  POST: "bg-[var(--color-accent-soft)] text-[var(--color-accent)]",
  DEL: "bg-[var(--color-bad-soft)] text-[var(--color-bad)]",
};

function EpHead({
  method,
  path,
  summary,
  border = true,
}: {
  method: Method;
  path: string;
  summary?: string;
  border?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2.5 bg-[var(--color-surface-2)] px-4 py-3",
        border && "border-b border-[var(--color-line)]",
      )}
    >
      <span
        className={cn(
          "rounded-[6px] px-2 py-0.5 font-[var(--font-mono)] text-[11px] font-bold",
          METHOD_TONE[method],
        )}
      >
        {method}
      </span>
      <span className="font-[var(--font-mono)] text-[13px] font-medium text-[var(--color-ink)]">
        {path}
      </span>
      {summary && (
        <span className="ml-auto text-[12.5px] text-[var(--color-ink-muted)]">{summary}</span>
      )}
    </div>
  );
}

function Endpoint({ children }: { children: ReactNode }) {
  return (
    <div className="mb-4 overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)]">
      {children}
    </div>
  );
}

function EpBody({ children }: { children: ReactNode }) {
  return <div className="space-y-3 p-4 text-[13px] leading-relaxed text-[var(--color-ink-dim)]">{children}</div>;
}

function BlockLabel({ children }: { children: ReactNode }) {
  return (
    <div className="pt-1 font-[var(--font-mono)] text-[10px] uppercase tracking-[0.12em] text-[var(--color-ink-muted)]">
      {children}
    </div>
  );
}

function Code({ children }: { children: string }) {
  return (
    <div className="group relative overflow-x-auto rounded-[var(--radius-field)] border border-[var(--color-line)] bg-[#06070d] p-3.5 font-[var(--font-mono)] text-[12.5px] leading-relaxed text-[var(--color-ink-dim)]">
      <pre className="whitespace-pre">{children}</pre>
      <div className="absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100">
        <CopyButton value={children} />
      </div>
    </div>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-[var(--color-surface-2)] px-1.5 py-0.5 font-[var(--font-mono)] text-[12px] text-[var(--color-cyan)]">
      {children}
    </code>
  );
}

function ParamsTable({
  cols,
  rows,
}: {
  cols: string[];
  rows: ReactNode[][];
}) {
  return (
    <table className="mt-1 w-full border-collapse text-[12.5px]">
      <thead>
        <tr>
          {cols.map((c) => (
            <th
              key={c}
              className="border-b border-[var(--color-line-strong)] px-2.5 py-1.5 text-left font-[var(--font-mono)] text-[10px] uppercase tracking-[0.1em] text-[var(--color-ink-muted)]"
            >
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((cell, j) => (
              <td
                key={j}
                className="border-b border-[var(--color-line)] px-2.5 py-2 align-top text-[var(--color-ink-dim)] last:border-0"
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Pname({ children, required }: { children: ReactNode; required?: boolean }) {
  return (
    <span className="whitespace-nowrap font-[var(--font-mono)] text-[var(--color-ink)]">
      {children}
      {required && <span className="ml-1.5 text-[10px] text-[var(--color-accent)]">required</span>}
    </span>
  );
}

function Section({ id, title, note, children }: { id: string; title: string; note: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 pt-8">
      <h2 className="mb-1.5 font-[var(--font-display)] text-xl font-semibold tracking-tight text-[var(--color-ink)]">
        {title}
      </h2>
      <p className="mb-4 max-w-[64ch] text-[13px] leading-relaxed text-[var(--color-ink-dim)]">{note}</p>
      {children}
    </section>
  );
}

export function ApiDocsPage() {
  const host = useMemo(() => (typeof location !== "undefined" ? location.origin : ""), []);
  const [active, setActive] = useState("overview");
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-64px 0px -70% 0px", threshold: 0.06 },
    );
    SECTIONS.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) obs.observe(el);
    });
    return () => obs.disconnect();
  }, []);

  return (
    <Container className="max-w-6xl">
      <div className="grid gap-10 lg:grid-cols-[200px_1fr]">
        {/* Sidebar */}
        <aside className="sticky top-20 hidden self-start lg:block">
          <div className="mb-3 pl-3 font-[var(--font-mono)] text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-ink-muted)]">
            Reference
          </div>
          <nav className="flex flex-col border-l border-[var(--color-line)]">
            {SECTIONS.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth" });
                  history.replaceState(null, "", `#${s.id}`);
                }}
                className={cn(
                  "-ml-px border-l-2 py-1.5 pl-3 text-[13px] transition-colors",
                  active === s.id
                    ? "border-[var(--color-accent)] text-[var(--color-accent)]"
                    : "border-transparent text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]",
                )}
              >
                {s.label}
              </a>
            ))}
          </nav>
        </aside>

        {/* Main */}
        <main ref={mainRef} className="min-w-0">
          <header className="reveal mb-8">
            <Eyebrow className="mb-3.5 inline-flex items-center gap-2 before:block before:h-[7px] before:w-[7px] before:rotate-45 before:rounded-[2px] before:bg-[var(--color-accent)] before:shadow-[0_0_10px_var(--color-accent)]">
              API Reference
            </Eyebrow>
            <h1 className="mb-2.5 font-[var(--font-display)] text-3xl font-bold tracking-tight text-[var(--color-ink)]">
              Dispatch files over HTTP
            </h1>
            <p className="max-w-[60ch] text-sm leading-relaxed text-[var(--color-ink-dim)]">
              A small, predictable REST API for uploading files, minting expiring links, and sharing
              whole folders as one download. Every example below is wired to the host you're reading
              this on — copy and run them as-is.
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-4 py-3">
              <span className="font-[var(--font-mono)] text-[10px] uppercase tracking-[0.12em] text-[var(--color-ink-muted)]">
                Your base URL
              </span>
              <span className="min-w-0 flex-1 break-all font-[var(--font-mono)] text-[13px] font-medium text-[var(--color-accent)]">
                {host}
              </span>
              <CopyButton value={host} />
            </div>
          </header>

          <Section
            id="overview"
            title="Overview"
            note="The API speaks JSON and standard multipart uploads. Authenticated calls use a Bearer API key; download links are public and act as their own credential. Paths are relative to your base URL above."
          >
            <Endpoint>
              <EpHead method="POST" path="/files/upload" summary="store a file, get a link" />
              <EpHead method="POST" path="/directories" summary="create a shareable folder" />
              <EpHead method="GET" path="/file/{slug}/raw" summary="download bytes" />
              <EpHead method="GET" path="/d/{slug}/zip" summary="download a folder as .zip" />
              <EpHead method="DEL" path="/directories/{id}" summary="delete a folder + contents" border={false} />
            </Endpoint>
          </Section>

          <Section
            id="auth"
            title="Authentication"
            note="Create an API key from the Files page → API Keys. Send it as a Bearer token on every authenticated request. Keys bind to the first IP that uses them — if your address changes, use Reset IP in-app. Key creation, revocation, and IP reset are deliberately app-only; they are not exposed over the API."
          >
            <Endpoint>
              <EpBody>
                <BlockLabel>Header</BlockLabel>
                <Code>{`Authorization: Bearer <your-api-key>`}</Code>
              </EpBody>
            </Endpoint>
          </Section>

          <Section
            id="upload"
            title="Upload a file"
            note={
              <>
                Send a multipart form. You get back a public share link and (for server-side
                encryption) an access key to append as <Mono>?ek=</Mono>.
              </>
            }
          >
            <Endpoint>
              <EpHead method="POST" path="/files/upload" border />
              <EpBody>
                <BlockLabel>Request</BlockLabel>
                <Code>{`curl -X POST ${host}/files/upload \\
  -H "Authorization: Bearer <key>" \\
  -F "file=@/path/to/report.pdf" \\
  -F "original_filename=report.pdf"`}</Code>

                <BlockLabel>Form fields</BlockLabel>
                <ParamsTable
                  cols={["Field", "Type", "Description"]}
                  rows={[
                    [<Pname required>file</Pname>, "file", "The file contents."],
                    [<Pname required>original_filename</Pname>, "string", "Name shown to downloaders."],
                    [<Pname>max_uses</Pname>, "int", "Deactivate the link after this many downloads."],
                    [<Pname>expires_in_seconds</Pname>, "int", "Link auto-expires after this many seconds."],
                    [
                      <Pname>encryption_mode</Pname>,
                      "string",
                      <>
                        <Mono>none</Mono> · <Mono>server</Mono> · <Mono>client</Mono>. See Encryption.
                      </>,
                    ],
                    [<Pname>compress</Pname>, "bool", "zstd-compress before storing (skipped for already-compressed types)."],
                    [<Pname>randomize_filename</Pname>, "bool", "Show a random name on the download page."],
                    [<Pname>temp_days</Pname>, "int", "Delete the file this many days after upload."],
                    [<Pname>delete_if_idle_days</Pname>, "int", "Delete if not downloaded within this many days."],
                    [<Pname>directory_id</Pname>, "int", "Attach to a folder. The folder's encryption wins."],
                  ]}
                />

                <BlockLabel>Response</BlockLabel>
                <Code>{`{
  "slug": "abc123",
  "url": "${host}/file/abc123",
  "raw_url": "${host}/file/abc123/raw",
  "encryption_mode": "none",
  "access_key": null
}`}</Code>
              </EpBody>
            </Endpoint>
          </Section>

          <Section
            id="download"
            title="Download"
            note={
              <>
                The link is the credential — no auth header needed. Server-encrypted files require
                their <Mono>?ek=</Mono> access key. Range requests are supported for unencrypted files.
              </>
            }
          >
            <Endpoint>
              <EpHead method="GET" path="/file/{slug}/raw" border />
              <EpBody>
                <BlockLabel>Download bytes</BlockLabel>
                <Code>{`curl -L -O "${host}/file/abc123/raw"`}</Code>
                <BlockLabel>Server-encrypted — pass the access key</BlockLabel>
                <Code>{`curl -L -O "${host}/file/abc123/raw?ek=<access-key>"`}</Code>
                <BlockLabel>Range request</BlockLabel>
                <Code>{`curl -L -r 0-1023 -o chunk.bin "${host}/file/abc123/raw"`}</Code>
                <p>
                  <strong className="text-[var(--color-ink)]">Client-encrypted (end-to-end)</strong>{" "}
                  files stream as ciphertext; the key lives only in the link's <Mono>#ek=</Mono>{" "}
                  fragment and never reaches the server. Decrypt in the browser via the in-app
                  download page.
                </p>
              </EpBody>
            </Endpoint>
          </Section>

          <Section id="info" title="File metadata" note="Fetch details without consuming a download.">
            <Endpoint>
              <EpHead method="GET" path="/file/{slug}/info" border />
              <EpBody>
                <Code>{`curl "${host}/file/abc123/info"`}</Code>
                <p>
                  Returns <Mono>filename</Mono>, <Mono>size_bytes</Mono>, <Mono>content_type</Mono>,{" "}
                  <Mono>encryption_mode</Mono>, <Mono>max_uses</Mono>, <Mono>use_count</Mono>, and{" "}
                  <Mono>expires_at</Mono>.
                </p>
              </EpBody>
            </Endpoint>
          </Section>

          <Section
            id="folders"
            title="Folders"
            note={
              <>
                A folder bundles many files behind one link at <Mono>{host}/d/{"{slug}"}</Mono>. Every
                file in a folder shares a single encryption key, so one <Mono>?ek=</Mono> (or one{" "}
                <Mono>#ek=</Mono>) unlocks the whole bundle. Create the folder first, then upload
                files into it with <Mono>directory_id</Mono>.
              </>
            }
          >
            <Endpoint>
              <EpHead method="POST" path="/directories" summary="create a folder" border />
              <EpBody>
                <BlockLabel>Request</BlockLabel>
                <Code>{`curl -X POST ${host}/directories \\
  -H "Authorization: Bearer <key>" \\
  -H "Content-Type: application/json" \\
  -d '{"title": "Q3 assets", "encryption_mode": "server"}'`}</Code>
                <BlockLabel>Response</BlockLabel>
                <Code>{`{
  "id": 7,
  "slug": "foLd3r",
  "url": "${host}/d/foLd3r",
  "encryption_mode": "server",
  "access_key": "the-shared-?ek=-value"
}`}</Code>
                <p>Then upload into it — repeat per file, reusing the returned id:</p>
                <Code>{`curl -X POST ${host}/files/upload \\
  -H "Authorization: Bearer <key>" \\
  -F "file=@logo.svg" -F "original_filename=logo.svg" \\
  -F "directory_id=7"`}</Code>
              </EpBody>
            </Endpoint>

            <Endpoint>
              <EpHead method="GET" path="/d/{slug}/info" summary="list folder contents" border />
              <EpBody>
                <Code>{`curl "${host}/d/foLd3r/info"`}</Code>
                <p>
                  Returns <Mono>title</Mono>, <Mono>encryption_mode</Mono>, <Mono>file_count</Mono>,{" "}
                  <Mono>total_bytes</Mono>, and a <Mono>files</Mono> array of{" "}
                  <Mono>{`{slug, filename, size_bytes, content_type}`}</Mono>.
                </p>
              </EpBody>
            </Endpoint>

            <Endpoint>
              <EpHead method="GET" path="/d/{slug}/zip" summary="download everything" border />
              <EpBody>
                <Code>{`curl -L -O "${host}/d/foLd3r/zip?ek=<access-key>"`}</Code>
                <p>
                  Streams a <Mono>.zip</Mono> of every file. Server-encrypted folders need the{" "}
                  <Mono>?ek=</Mono> key. End-to-end folders can't be zipped server-side (the server
                  has no key) — use the folder page, which decrypts and zips in your browser.
                </p>
              </EpBody>
            </Endpoint>

            <Endpoint>
              <EpHead method="DEL" path="/directories/{id}" summary="delete folder + all files" border />
              <EpBody>
                <Code>{`curl -X DELETE ${host}/directories/7 \\
  -H "Authorization: Bearer <key>"`}</Code>
                <p>
                  Permanently removes the folder and every file inside it. Owners can delete their
                  own; master users can delete any.
                </p>
              </EpBody>
            </Endpoint>
          </Section>

          <Section
            id="encryption"
            title="Encryption"
            note="Three modes, chosen per file (or once per folder). They differ in who holds the key."
          >
            <Endpoint>
              <EpBody>
                <ParamsTable
                  cols={["Mode", "Key location", "Notes"]}
                  rows={[
                    [<Pname>none</Pname>, "—", "Stored as-is. The link is the only secret."],
                    [
                      <Pname>server</Pname>,
                      <Mono>?ek=</Mono>,
                      "Encrypted at rest. The server holds the key and gates each download on the access credential you share.",
                    ],
                    [
                      <Pname>client</Pname>,
                      <Mono>#ek=</Mono>,
                      "End-to-end. The browser encrypts before upload; the key rides in the URL fragment and never reaches the server.",
                    ],
                  ]}
                />
                <p>
                  The <Mono>#ek=</Mono> fragment is never sent in an HTTP request, so end-to-end keys
                  are unrecoverable if lost — save the full link at creation time.
                </p>
              </EpBody>
            </Endpoint>
          </Section>

          <Section
            id="errors"
            title="Errors"
            note={
              <>
                Standard HTTP status codes; the body is <Mono>{`{ "detail": "…" }`}</Mono>.
              </>
            }
          >
            <Endpoint>
              <EpBody>
                <ParamsTable
                  cols={["Status", "Meaning"]}
                  rows={[
                    [<Pname>400</Pname>, "Malformed request — bad mode, missing required field."],
                    [<Pname>401</Pname>, "Missing/invalid API key, or a missing/wrong ?ek= on an encrypted download."],
                    [<Pname>403</Pname>, "Authenticated, but not permitted (e.g. another user's file)."],
                    [<Pname>404</Pname>, "Unknown slug, or a link that expired / was used up / deactivated."],
                    [<Pname>413</Pname>, "File exceeds your max size or would blow your quota."],
                  ]}
                />
              </EpBody>
            </Endpoint>
          </Section>
        </main>
      </div>
    </Container>
  );
}
