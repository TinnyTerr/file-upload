import {
	AlertCircle,
	BookText,
	ChevronDown,
	ChevronRight,
	Download,
	FolderTree,
	Globe,
	Info,
	KeyRound,
	Link2,
	Radio,
	ShieldCheck,
	Upload,
} from "lucide-react";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/cn";

// ─── helpers ────────────────────────────────────────────────────────────────

function MethodBadge({
	method,
}: {
	method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
}) {
	const colors = {
		GET: "bg-blue-500/15 text-blue-500 border-blue-500/30",
		POST: "bg-green-500/15 text-green-500 border-green-500/30",
		PATCH: "bg-amber-500/15 text-amber-500 border-amber-500/30",
		DELETE: "bg-red-500/15 text-red-500 border-red-500/30",
		PUT: "bg-purple-500/15 text-purple-500 border-purple-500/30",
	};
	return (
		<span
			className={cn(
				"rounded border px-1.5 py-0.5 font-mono text-[11px] font-bold",
				colors[method],
			)}
		>
			{method}
		</span>
	);
}

function CodeBlock({ code }: { code: string; lang?: string }) {
	return (
		<div className="relative">
			<pre className="overflow-x-auto rounded-lg border border-border bg-background/50 p-3 pr-12 font-mono text-xs leading-relaxed whitespace-pre">
				{code}
			</pre>
			<div className="absolute right-2 top-2">
				<CopyButton value={code} />
			</div>
		</div>
	);
}

type Lang = "curl" | "python" | "node";

function LangTabs({ examples }: { examples: Record<Lang, string> }) {
	const [lang, setLang] = useState<Lang>("curl");
	const tabs: { id: Lang; label: string }[] = [
		{ id: "curl", label: "cURL" },
		{ id: "python", label: "Python" },
		{ id: "node", label: "Node.js" },
	];
	return (
		<div className="space-y-2">
			<div className="flex gap-1 rounded-md border border-border bg-secondary/20 p-1 w-fit">
				{tabs.map((t) => (
					<button
						key={t.id}
						onClick={() => setLang(t.id)}
						className={cn(
							"rounded px-3 py-1 text-xs font-medium transition-colors",
							lang === t.id
								? "bg-background text-foreground shadow-sm"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{t.label}
					</button>
				))}
			</div>
			<CodeBlock code={examples[lang]} />
		</div>
	);
}

interface ParamRow {
	name: string;
	type: string;
	required?: boolean;
	description: string;
}

function ParamTable({
	params,
	title = "Parameters",
}: {
	params: ParamRow[];
	title?: string;
}) {
	return (
		<div className="space-y-1.5">
			<p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
				{title}
			</p>
			<div className="rounded-lg border border-border overflow-hidden">
				<table className="w-full text-xs">
					<thead>
						<tr className="border-b border-border bg-secondary/30">
							<th className="text-left px-3 py-2 font-medium text-muted-foreground w-40">
								Name
							</th>
							<th className="text-left px-3 py-2 font-medium text-muted-foreground w-28">
								Type
							</th>
							<th className="text-left px-3 py-2 font-medium text-muted-foreground">
								Description
							</th>
						</tr>
					</thead>
					<tbody>
						{params.map((p) => (
							<tr key={p.name} className="border-b border-border last:border-0">
								<td className="px-3 py-2 font-mono">
									{p.name}
									{p.required && (
										<span className="ml-1 text-destructive">*</span>
									)}
								</td>
								<td className="px-3 py-2 text-muted-foreground font-mono">
									{p.type}
								</td>
								<td className="px-3 py-2 text-muted-foreground">
									{p.description}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<p className="text-[11px] text-muted-foreground/60">
				Fields marked <span className="text-destructive">*</span> are required.
			</p>
		</div>
	);
}

function ResponseBlock({ json }: { json: object }) {
	const code = JSON.stringify(json, null, 2);
	return (
		<div className="space-y-1.5">
			<p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
				Response (200 OK)
			</p>
			<CodeBlock code={code} lang="json" />
		</div>
	);
}

function Endpoint({
	id,
	method,
	path,
	title,
	description,
	children,
}: {
	id: string;
	method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
	path: string;
	title: string;
	description: string;
	children: React.ReactNode;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div id={id} className="rounded-lg border border-border scroll-mt-20">
			<button
				className="w-full flex items-center gap-3 p-4 text-left hover:bg-secondary/10 transition-colors"
				onClick={() => setOpen((o) => !o)}
			>
				<MethodBadge method={method} />
				<code className="flex-1 font-mono text-sm text-foreground">{path}</code>
				<span className="hidden sm:block text-sm text-muted-foreground mr-2">
					{title}
				</span>
				{open ? (
					<ChevronDown className="size-4 text-muted-foreground shrink-0" />
				) : (
					<ChevronRight className="size-4 text-muted-foreground shrink-0" />
				)}
			</button>
			{open && (
				<div className="border-t border-border px-4 pb-4 pt-3 space-y-4 text-sm text-muted-foreground">
					<p>{description}</p>
					{children}
				</div>
			)}
		</div>
	);
}

function SectionHeader({
	icon: Icon,
	title,
	id,
}: {
	icon: React.ComponentType<{ className?: string }>;
	title: string;
	id: string;
}) {
	return (
		<div
			id={id}
			className="flex items-center gap-2 scroll-mt-20 pb-1 border-b border-border"
		>
			<Icon className="size-4 text-primary" />
			<h2 className="text-base font-semibold">{title}</h2>
		</div>
	);
}

// ─── main component ──────────────────────────────────────────────────────────

export function ApiDocsPage() {
	const origin = useMemo(() => window.location.origin, []);
	const [apiKey, setApiKey] = useState("");
	const key = apiKey.trim() || "<your-api-key>";

	const sections = [
		{ id: "getting-started", label: "Getting started" },
		{ id: "files-section", label: "Files" },
		{ id: "links-section", label: "Links" },
		{ id: "folders-section", label: "Folders" },
		{ id: "dropbox-section", label: "Dropbox" },
		{ id: "account-section", label: "Account" },
		{ id: "realtime-section", label: "Realtime" },
		{ id: "encryption-section", label: "Encryption" },
		{ id: "errors-section", label: "Errors" },
	];

	return (
		<div className="space-y-6">
			<PageHeader
				title="API reference"
				subtitle="Upload, download, and manage files programmatically."
				icon={BookText}
			/>

			{/* nav */}
			<nav
				aria-label="API sections"
				className="flex flex-wrap gap-2 rounded-lg border border-border bg-secondary/20 p-2"
			>
				{sections.map((s) => (
					<a
						key={s.id}
						href={`#${s.id}`}
						className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						{s.label}
					</a>
				))}
			</nav>

			{/* api key input */}
			<Card className="border-primary/20 bg-primary/5">
				<CardContent className="pt-4 space-y-2">
					<Label
						htmlFor="api-key-input"
						className="flex items-center gap-2 text-sm font-medium"
					>
						<KeyRound className="size-4 text-primary" />
						Your API key — paste it here to auto-fill all examples below
					</Label>
					<div className="flex gap-2">
						<Input
							id="api-key-input"
							type="password"
							placeholder="fu_..."
							value={apiKey}
							onChange={(e) => setApiKey(e.target.value)}
							className="font-mono max-w-md"
						/>
						{apiKey && (
							<Button variant="ghost" size="sm" onClick={() => setApiKey("")}>
								Clear
							</Button>
						)}
					</div>
					<p className="text-xs text-muted-foreground">
						Keys never leave your browser — they're only used to populate the
						code snippets on this page. Create one from{" "}
						<strong>API keys</strong> in the sidebar.
					</p>
				</CardContent>
			</Card>

			{/* ── getting started ── */}
			<SectionHeader
				id="getting-started"
				icon={KeyRound}
				title="Getting started"
			/>

			<Card>
				<CardContent className="pt-4 space-y-4 text-sm text-muted-foreground">
					<p>
						All API requests authenticate with a Bearer token in the{" "}
						<code>Authorization</code> header. API keys require the{" "}
						<Badge variant="secondary" className="text-xs">
							can_use_api_keys
						</Badge>{" "}
						permission and are created from the <strong>API keys</strong> page.
					</p>
					<CodeBlock code={`Authorization: Bearer ${key}`} />
					<div className="rounded-md border border-border p-3 space-y-1.5">
						<p className="font-medium text-foreground">IP binding</p>
						<p>
							A key binds to the first IP address it is used from. If you change
							networks, reset the binding from the API keys page. You can also
							pre-bind a key to a specific CIDR or IP.
						</p>
					</div>
					<div className="rounded-md border border-border p-3 space-y-1.5">
						<p className="font-medium text-foreground">Base URL</p>
						<CodeBlock code={origin} />
					</div>
					<div className="rounded-md border border-border p-3 space-y-1.5">
						<p className="font-medium text-foreground">Content type</p>
						<p>
							Uploads use <code>multipart/form-data</code>. All other request
							bodies are
							<code> application/json</code>. Responses are always{" "}
							<code>application/json</code> unless you are downloading raw file
							content.
						</p>
					</div>
				</CardContent>
			</Card>

			{/* ── files ── */}
			<SectionHeader id="files-section" icon={Upload} title="Files" />

			<Endpoint
				id="ep-list-files"
				method="GET"
				path="/api/files/"
				title="List files"
				description="Returns all files owned by or shared with the authenticated user."
			>
				<LangTabs
					examples={{
						curl: `curl "${origin}/api/files/" \\\n  -H "Authorization: Bearer ${key}"`,
						python: `import requests\n\nresp = requests.get(\n    "${origin}/api/files/",\n    headers={"Authorization": "Bearer ${key}"}\n)\nfiles = resp.json()["files"]\nfor f in files:\n    print(f["original_filename"], f["size_bytes"])`,
						node: `const res = await fetch("${origin}/api/files/", {\n  headers: { "Authorization": "Bearer ${key}" }\n});\nconst { files } = await res.json();\nconsole.log(files);`,
					}}
				/>
				<ResponseBlock
					json={{
						files: [
							{
								id: 1,
								original_filename: "report.pdf",
								size_bytes: 204800,
								encryption_mode: "none",
								source_type: "upload",
								created_at: "2026-01-15T10:30:00Z",
								links: [
									{
										id: 1,
										slug: "ab12cd34",
										use_count: 0,
										max_uses: null,
										expires_at: null,
										active: true,
										hide_uploader: false,
									},
								],
							},
						],
					}}
				/>
			</Endpoint>

			<Endpoint
				id="ep-upload"
				method="POST"
				path="/api/files/upload"
				title="Upload a file"
				description="Upload a file using multipart/form-data. Returns a shareable link and metadata."
			>
				<ParamTable
					title="Form fields"
					params={[
						{
							name: "file",
							type: "file",
							required: true,
							description: "The file binary.",
						},
						{
							name: "original_filename",
							type: "string",
							required: true,
							description: "Filename to display to recipients.",
						},
						{
							name: "encryption_mode",
							type: "string",
							description: "none | server | client (default: none).",
						},
						{
							name: "max_uses",
							type: "integer",
							description:
								"Maximum number of downloads before the link is exhausted.",
						},
						{
							name: "expires_in_seconds",
							type: "integer",
							description: "TTL in seconds from now.",
						},
						{
							name: "compress",
							type: "boolean",
							description: "Gzip the file before storing (default false).",
						},
						{
							name: "randomize_filename",
							type: "boolean",
							description: "Store under a random name (default false).",
						},
					]}
				/>
				<LangTabs
					examples={{
						curl: `curl -X POST "${origin}/api/files/upload" \\\n  -H "Authorization: Bearer ${key}" \\\n  -F "file=@./report.pdf" \\\n  -F "original_filename=report.pdf" \\\n  -F "encryption_mode=none"`,
						python: `import requests\n\nwith open("report.pdf", "rb") as f:\n    resp = requests.post(\n        "${origin}/api/files/upload",\n        headers={"Authorization": "Bearer ${key}"},\n        files={"file": f},\n        data={\n            "original_filename": "report.pdf",\n            "encryption_mode": "none",\n        },\n    )\nprint(resp.json())`,
						node: `import { createReadStream } from "fs";\nimport FormData from "form-data";\nimport fetch from "node-fetch";\n\nconst form = new FormData();\nform.append("file", createReadStream("report.pdf"));\nform.append("original_filename", "report.pdf");\nform.append("encryption_mode", "none");\n\nconst res = await fetch("${origin}/api/files/upload", {\n  method: "POST",\n  headers: { "Authorization": "Bearer ${key}", ...form.getHeaders() },\n  body: form,\n});\nconsole.log(await res.json());`,
					}}
				/>
				<ResponseBlock
					json={{
						id: 1,
						slug: "ab12cd34",
						url: `${origin}/api/file/ab12cd34`,
						raw_url: `${origin}/api/file/ab12cd34/raw`,
						encryption_mode: "none",
						access_key: null,
					}}
				/>
			</Endpoint>

			<Endpoint
				id="ep-delete-file"
				method="DELETE"
				path="/api/files/{file_id}"
				title="Delete a file"
				description="Permanently deletes the file and all its share links. Requires can_delete permission."
			>
				<ParamTable
					title="Path parameters"
					params={[
						{
							name: "file_id",
							type: "integer",
							required: true,
							description: "The numeric file ID.",
						},
					]}
				/>
				<LangTabs
					examples={{
						curl: `curl -X DELETE "${origin}/api/files/1" \\\n  -H "Authorization: Bearer ${key}"`,
						python: `requests.delete(\n    "${origin}/api/files/1",\n    headers={"Authorization": "Bearer ${key}"}\n)`,
						node: `await fetch("${origin}/api/files/1", {\n  method: "DELETE",\n  headers: { "Authorization": "Bearer ${key}" }\n});`,
					}}
				/>
				<ResponseBlock json={{ status: "deleted" }} />
			</Endpoint>

			{/* ── links ── */}
			<SectionHeader id="links-section" icon={Link2} title="Links" />

			<Endpoint
				id="ep-create-link"
				method="POST"
				path="/api/files/{file_id}/links"
				title="Create a share link"
				description="Mints a new share link for a file. You can create multiple links with different limits."
			>
				<ParamTable
					title="Path parameters"
					params={[
						{
							name: "file_id",
							type: "integer",
							required: true,
							description: "The numeric file ID.",
						},
					]}
				/>
				<ParamTable
					title="Request body (JSON)"
					params={[
						{
							name: "max_uses",
							type: "integer | null",
							description: "Maximum downloads. null = unlimited.",
						},
						{
							name: "expires_in_seconds",
							type: "integer | null",
							description: "TTL in seconds from now.",
						},
						{
							name: "hide_uploader",
							type: "boolean",
							description:
								"If true, the uploader's name and avatar are hidden from recipients (default false).",
						},
					]}
				/>
				<LangTabs
					examples={{
						curl: `curl -X POST "${origin}/api/files/1/links" \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"max_uses": 10, "expires_in_seconds": 86400, "hide_uploader": false}'`,
						python: `resp = requests.post(\n    "${origin}/api/files/1/links",\n    headers={"Authorization": "Bearer ${key}"},\n    json={"max_uses": 10, "expires_in_seconds": 86400}\n)\nprint(resp.json()["url"])`,
						node: `const res = await fetch("${origin}/api/files/1/links", {\n  method: "POST",\n  headers: {\n    "Authorization": "Bearer ${key}",\n    "Content-Type": "application/json",\n  },\n  body: JSON.stringify({ max_uses: 10, expires_in_seconds: 86400 }),\n});\nconsole.log(await res.json());`,
					}}
				/>
				<ResponseBlock
					json={{
						slug: "ab12cd34",
						url: `${origin}/api/file/ab12cd34`,
						raw_url: `${origin}/api/file/ab12cd34/raw`,
						encryption_mode: "none",
						access_key: null,
					}}
				/>
			</Endpoint>

			<Endpoint
				id="ep-edit-link"
				method="PATCH"
				path="/api/links/{link_id}"
				title="Edit a share link"
				description="Update a link's limits, active state, or uploader visibility. Only supply fields you want to change."
			>
				<ParamTable
					title="Request body (JSON)"
					params={[
						{
							name: "max_uses",
							type: "integer | null",
							description: "New download cap. null = unlimited.",
						},
						{
							name: "expires_in_seconds",
							type: "integer | null",
							description: "New TTL from now.",
						},
						{
							name: "active",
							type: "boolean",
							description: "Enable or disable the link.",
						},
						{
							name: "hide_uploader",
							type: "boolean",
							description: "Toggle uploader visibility for recipients.",
						},
					]}
				/>
				<LangTabs
					examples={{
						curl: `curl -X PATCH "${origin}/api/links/1" \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"active": false}'`,
						python: `requests.patch(\n    "${origin}/api/links/1",\n    headers={"Authorization": "Bearer ${key}"},\n    json={"active": False}\n)`,
						node: `await fetch("${origin}/api/links/1", {\n  method: "PATCH",\n  headers: {\n    "Authorization": "Bearer ${key}",\n    "Content-Type": "application/json",\n  },\n  body: JSON.stringify({ active: false }),\n});`,
					}}
				/>
				<ResponseBlock json={{ status: "updated" }} />
			</Endpoint>

			<Endpoint
				id="ep-delete-link"
				method="DELETE"
				path="/api/links/{link_id}"
				title="Delete a share link"
				description="Permanently removes a share link. Existing users with the URL can no longer download."
			>
				<LangTabs
					examples={{
						curl: `curl -X DELETE "${origin}/api/links/1" \\\n  -H "Authorization: Bearer ${key}"`,
						python: `requests.delete("${origin}/api/links/1", headers={"Authorization": "Bearer ${key}"})`,
						node: `await fetch("${origin}/api/links/1", {\n  method: "DELETE",\n  headers: { "Authorization": "Bearer ${key}" }\n});`,
					}}
				/>
				<ResponseBlock json={{ status: "deleted" }} />
			</Endpoint>

			{/* ── public download ── */}
			<SectionHeader
				id="download-section"
				icon={Download}
				title="Public download"
			/>

			<Endpoint
				id="ep-file-info"
				method="GET"
				path="/api/file/{slug}/info"
				title="File metadata"
				description="Fetch metadata for a public file link without consuming a download or requiring auth."
			>
				<ParamTable
					title="Query parameters"
					params={[
						{
							name: "ek",
							type: "string",
							description:
								"Server-mode access key (required for server-encrypted files).",
						},
					]}
				/>
				<LangTabs
					examples={{
						curl: `curl "${origin}/api/file/ab12cd34/info"`,
						python: `resp = requests.get("${origin}/api/file/ab12cd34/info")\ninfo = resp.json()\nprint(info["original_filename"], info["size_bytes"])`,
						node: `const res = await fetch("${origin}/api/file/ab12cd34/info");\nconsole.log(await res.json());`,
					}}
				/>
				<ResponseBlock
					json={{
						original_filename: "report.pdf",
						content_type: "application/pdf",
						size_bytes: 204800,
						encryption_mode: "none",
						compressed: false,
						use_count: 2,
						max_uses: 10,
						expires_at: null,
						uploader: { username: "alice", has_avatar: true, user_id: 5 },
						already_saved: false,
					}}
				/>
			</Endpoint>

			<Endpoint
				id="ep-download"
				method="GET"
				path="/api/file/{slug}/raw"
				title="Download file"
				description="Download the raw file content. For server-encrypted files, include the access key. For client-encrypted files, you receive ciphertext that must be decrypted locally."
			>
				<ParamTable
					title="Query parameters"
					params={[
						{
							name: "ek",
							type: "string",
							description:
								"Required for server-encrypted files. The access key returned by the upload or link creation response.",
						},
					]}
				/>
				<LangTabs
					examples={{
						curl: `# Unencrypted\ncurl -L -O "${origin}/api/file/ab12cd34/raw"\n\n# Server-encrypted\ncurl -L -O "${origin}/api/file/ab12cd34/raw?ek=<access_key>"`,
						python: `import shutil, requests\n\nwith requests.get("${origin}/api/file/ab12cd34/raw", stream=True) as r:\n    r.raise_for_status()\n    with open("download.pdf", "wb") as f:\n        shutil.copyfileobj(r.raw, f)`,
						node: `import { createWriteStream } from "fs";\nimport fetch from "node-fetch";\n\nconst res = await fetch("${origin}/api/file/ab12cd34/raw");\nconst dest = createWriteStream("download.pdf");\nawait new Promise((resolve, reject) => {\n  res.body.pipe(dest);\n  res.body.on("error", reject);\n  dest.on("finish", resolve);\n});`,
					}}
				/>
			</Endpoint>

			{/* ── folders ── */}
			<SectionHeader id="folders-section" icon={FolderTree} title="Folders" />

			<Endpoint
				id="ep-list-folders"
				method="GET"
				path="/api/directories/"
				title="List folders"
				description="Returns all folders you own or are a collaborator on."
			>
				<LangTabs
					examples={{
						curl: `curl "${origin}/api/directories/" \\\n  -H "Authorization: Bearer ${key}"`,
						python: `resp = requests.get(\n    "${origin}/api/directories/",\n    headers={"Authorization": "Bearer ${key}"}\n)\nfor d in resp.json()["directories"]:\n    print(d["title"], d["file_count"])`,
						node: `const res = await fetch("${origin}/api/directories/", {\n  headers: { "Authorization": "Bearer ${key}" }\n});\nconst { directories } = await res.json();\nconsole.log(directories);`,
					}}
				/>
				<ResponseBlock
					json={{
						directories: [
							{
								id: 1,
								title: "Project files",
								slug: "xy99zz",
								file_count: 4,
								total_bytes: 819200,
								encryption_mode: "none",
								role: "owner",
								created_at: "2026-01-10T09:00:00Z",
							},
						],
					}}
				/>
			</Endpoint>

			<Endpoint
				id="ep-download-zip"
				method="GET"
				path="/api/d/{slug}/zip"
				title="Download folder as ZIP"
				description="Streams all files in a folder as a ZIP archive. Server-encrypted folders require the access key."
			>
				<ParamTable
					title="Query parameters"
					params={[
						{
							name: "ek",
							type: "string",
							description: "Required for server-encrypted folders.",
						},
					]}
				/>
				<LangTabs
					examples={{
						curl: `curl -L -O "${origin}/api/d/xy99zz/zip"`,
						python: `with requests.get("${origin}/api/d/xy99zz/zip", stream=True) as r:\n    r.raise_for_status()\n    with open("folder.zip", "wb") as f:\n        for chunk in r.iter_content(chunk_size=8192):\n            f.write(chunk)`,
						node: `const res = await fetch("${origin}/api/d/xy99zz/zip");\nconst buffer = await res.arrayBuffer();\nimport { writeFileSync } from "fs";\nwriteFileSync("folder.zip", Buffer.from(buffer));`,
					}}
				/>
			</Endpoint>

			{/* ── dropbox ── */}
			<SectionHeader id="dropbox-section" icon={Globe} title="Dropbox" />

			<Endpoint
				id="ep-dropbox-upload"
				method="POST"
				path="/api/dropbox/{slug}"
				title="Upload to a dropbox"
				description="Upload a file to a dropbox link without authentication. The link owner receives it in their account. Supports the same form fields as the regular upload endpoint."
			>
				<ParamTable
					title="Form fields"
					params={[
						{
							name: "file",
							type: "file",
							required: true,
							description: "The file binary.",
						},
						{
							name: "original_filename",
							type: "string",
							required: true,
							description: "Filename to display to the owner.",
						},
						{
							name: "declared_size",
							type: "integer",
							description:
								"Declared file size in bytes (used for quota pre-check).",
						},
					]}
				/>
				<LangTabs
					examples={{
						curl: `curl -X POST "${origin}/api/dropbox/<dropbox-slug>" \\\n  -F "file=@./document.pdf" \\\n  -F "original_filename=document.pdf"`,
						python: `with open("document.pdf", "rb") as f:\n    resp = requests.post(\n        "${origin}/api/dropbox/<dropbox-slug>",\n        files={"file": f},\n        data={"original_filename": "document.pdf"},\n    )\nprint(resp.json())`,
						node: `const form = new FormData();\nform.append("file", createReadStream("document.pdf"));\nform.append("original_filename", "document.pdf");\n\nawait fetch("${origin}/api/dropbox/<dropbox-slug>", {\n  method: "POST",\n  body: form,\n});`,
					}}
				/>
				<ResponseBlock json={{ status: "received", file_id: 42 }} />
			</Endpoint>

			{/* ── account ── */}
			<SectionHeader id="account-section" icon={Info} title="Account" />

			<Endpoint
				id="ep-me"
				method="GET"
				path="/api/account/me"
				title="Get current user"
				description="Returns the authenticated user's profile, permissions, and quota."
			>
				<LangTabs
					examples={{
						curl: `curl "${origin}/api/account/me" \\\n  -H "Authorization: Bearer ${key}"`,
						python: `resp = requests.get(\n    "${origin}/api/account/me",\n    headers={"Authorization": "Bearer ${key}"}\n)\nme = resp.json()\nprint(me["username"], me["used_bytes"], "/", me["quota_bytes"])`,
						node: `const res = await fetch("${origin}/api/account/me", {\n  headers: { "Authorization": "Bearer ${key}" }\n});\nconsole.log(await res.json());`,
					}}
				/>
				<ResponseBlock
					json={{
						id: 5,
						username: "alice",
						role: "user",
						email: "alice@example.com",
						has_avatar: false,
						used_bytes: 204800,
						quota_bytes: 5368709120,
						can_upload: true,
						can_delete: true,
						can_use_api_keys: true,
						can_regenerate_links: true,
						can_delete_links: true,
						can_use_dropbox: false,
					}}
				/>
			</Endpoint>

			{/* ── encryption ── */}
			{/* ── realtime ── */}
			<SectionHeader id="realtime-section" icon={Radio} title="Realtime" />

			<Card>
				<CardContent className="pt-4 space-y-4 text-sm text-muted-foreground">
					<p>
						Every action on the server (uploads, deletes, logins, link changes,
						admin actions — anything that writes to the audit log) is published
						as an <strong>event</strong> in real time. Subscribe over WebSocket
						for a live stream of your own events. Cluster-wide streaming and
						node linking live on the <strong>Cluster</strong> page.
					</p>
					<div className="rounded-md border border-border p-3 space-y-1.5">
						<p className="font-medium text-foreground">Event payload</p>
						<p>
							Each frame is JSON. Stream frames carry a <code>type</code> of{" "}
							<code>ready</code> (sent once on connect) or <code>event</code>.
						</p>
						<CodeBlock
							lang="json"
							code={`{\n  "type": "event",\n  "id": 1421,            // monotonic per-process sequence — use as a cursor\n  "ts": "2026-06-29T12:00:00+00:00",\n  "action": "file.uploaded",\n  "actor": "alice",     // username, or "system" / "dropbox" / "apikey:<id>"\n  "target": "file:42",\n  "ip": "203.0.113.7"\n}`}
						/>
					</div>
					<div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 space-y-1.5">
						<p className="font-medium text-foreground">
							Reconnect without gaps
						</p>
						<p>
							The server retains a buffer of recent events. Pass the highest{" "}
							<code>id</code> you have already processed as <code>?after=</code>{" "}
							(WebSocket) or <code>?after=</code> (poll) to replay only what you
							missed.
						</p>
					</div>
				</CardContent>
			</Card>

			<Endpoint
				id="ep-user-ws"
				method="GET"
				path="/api/ws/events"
				title="Per-user event stream (WebSocket)"
				description="Authenticated by your session cookie — open it from the browser app. A regular user receives only their own events (across every session and node); a master receives the full firehose."
			>
				<ParamTable
					title="Query parameters"
					params={[
						{
							name: "after",
							type: "integer",
							description:
								"Replay buffered events with a higher id before streaming live ones. Optional.",
						},
					]}
				/>
				<LangTabs
					examples={{
						curl: `# WebSockets aren't curl-friendly; use websocat with your session cookie:\nwebsocat "${origin.replace(/^http/, "ws")}/api/ws/events" \\\n  -H "Cookie: fu_session=<your-session-cookie>"`,
						python: `import json, websockets, asyncio\n\nasync def main():\n    url = "${origin.replace(/^http/, "ws")}/api/ws/events"\n    async with websockets.connect(url, additional_headers={"Cookie": "fu_session=<cookie>"}) as ws:\n        async for raw in ws:\n            evt = json.loads(raw)\n            if evt["type"] == "event":\n                print(evt["action"], evt["actor"])\n\nasyncio.run(main())`,
						node: `const ws = new WebSocket("${origin.replace(/^http/, "ws")}/api/ws/events");\nws.onmessage = (m) => {\n  const evt = JSON.parse(m.data);\n  if (evt.type === "event") console.log(evt.action, evt.actor);\n};`,
					}}
				/>
				<p className="text-xs">
					Closes with code <code>4401</code> if the session cookie is missing or
					invalid.
				</p>
			</Endpoint>

			<Card className="border-primary/20 bg-primary/5">
				<CardContent className="pt-4 space-y-2 text-sm text-muted-foreground">
					<p className="flex items-center gap-2 font-medium text-foreground">
						<Radio className="size-4 text-primary" />
						Cluster firehose &amp; node linking
					</p>
					<p>
						The cluster-wide event firehose, HTTP poll, and the tooling to
						reveal/rotate this server's cluster token and link other nodes now
						live on the dedicated <strong>Cluster</strong> page (requires the{" "}
						<Badge variant="secondary" className="text-xs">
							can_manage_cluster
						</Badge>{" "}
						permission).
					</p>
				</CardContent>
			</Card>

			<SectionHeader
				id="encryption-section"
				icon={ShieldCheck}
				title="Encryption modes"
			/>

			<Card>
				<CardContent className="pt-4 space-y-4 text-sm text-muted-foreground">
					<p>
						Files support three encryption modes. Choose based on your security
						requirements.
					</p>
					<div className="space-y-3">
						{[
							{
								name: "none",
								title: "No encryption",
								detail:
									"The link slug is the only credential. Anyone with the link can download the file. Fast and simple for non-sensitive content.",
								download: `${origin}/api/file/<slug>/raw`,
							},
							{
								name: "server",
								title: "Server-side encryption",
								detail:
									"The server encrypts the file at rest. An access key (?ek=...) is required to download. The server holds the key — use this when you need convenient sharing but don't require end-to-end security.",
								download: `${origin}/api/file/<slug>/raw?ek=<access_key>`,
							},
							{
								name: "client",
								title: "End-to-end (client-side) encryption",
								detail:
									"The file is encrypted in the browser before upload. The server never sees the plaintext. The #ek= fragment is never sent to the server. Ideal for maximum privacy — but the server cannot decrypt even if compelled.",
								download: `${origin}/api/file/<slug>#ek=<client_key>`,
							},
						].map((e) => (
							<div
								key={e.name}
								className="rounded-md border border-border p-3 space-y-1.5"
							>
								<div className="flex items-center gap-2">
									<code className="rounded bg-secondary px-1.5 py-0.5 text-xs font-bold text-foreground">
										{e.name}
									</code>
									<span className="text-sm font-medium text-foreground">
										{e.title}
									</span>
								</div>
								<p>{e.detail}</p>
								<CodeBlock code={`# Download URL\n${e.download}`} />
							</div>
						))}
					</div>
				</CardContent>
			</Card>

			{/* ── errors ── */}
			<SectionHeader id="errors-section" icon={AlertCircle} title="Errors" />

			<Card>
				<CardContent className="pt-4 space-y-4 text-sm text-muted-foreground">
					<p>
						All error responses use JSON with a <code>detail</code> field:
					</p>
					<CodeBlock code={`{"detail": "not found"}`} lang="json" />
					<div className="rounded-lg border border-border overflow-hidden">
						<table className="w-full text-xs">
							<thead>
								<tr className="border-b border-border bg-secondary/30">
									<th className="text-left px-3 py-2 font-medium text-muted-foreground w-20">
										Status
									</th>
									<th className="text-left px-3 py-2 font-medium text-muted-foreground">
										Meaning
									</th>
									<th className="text-left px-3 py-2 font-medium text-muted-foreground">
										Common cause
									</th>
								</tr>
							</thead>
							<tbody>
								{[
									[
										"400",
										"Bad request",
										"Invalid body, missing required field, or value out of range.",
									],
									[
										"401",
										"Unauthorized",
										"Missing or invalid API key / session. Check your Authorization header.",
									],
									[
										"403",
										"Forbidden",
										"Your account lacks the required permission, or you don't own the resource.",
									],
									[
										"404",
										"Not found",
										"Unknown slug, expired link, exhausted download count, or deleted file.",
									],
									[
										"409",
										"Conflict",
										"Duplicate save — you already saved this file, or you own it.",
									],
									[
										"413",
										"Payload too large",
										"File exceeds your remaining quota or the per-file size cap.",
									],
									[
										"422",
										"Unprocessable",
										"Pydantic validation failed — check field types and constraints.",
									],
									[
										"429",
										"Too many requests",
										"Rate limit hit. Back off and retry after a short delay.",
									],
									[
										"500",
										"Server error",
										"Unexpected internal error. Contact the admin.",
									],
								].map(([status, meaning, cause]) => (
									<tr
										key={status}
										className="border-b border-border last:border-0"
									>
										<td className="px-3 py-2 font-mono font-bold text-foreground">
											{status}
										</td>
										<td className="px-3 py-2 text-foreground">{meaning}</td>
										<td className="px-3 py-2">{cause}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
