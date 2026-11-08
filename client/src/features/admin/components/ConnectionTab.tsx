import { Activity, Gauge, Radio } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	CHUNK_MAX,
	CHUNK_MIN,
	nextChunkLength,
	TARGET_CHUNK_SECONDS,
} from "@/features/files/lib/chunkPlanner";
import { useConnectionTest } from "../hooks/useConnectionTest";

const MIB = 1024 * 1024;
const KIB = 1024;

function size(bytes: number): string {
	if (bytes >= MIB) return `${(bytes / MIB).toFixed(bytes % MIB ? 2 : 0)} MiB`;
	return `${(bytes / KIB).toFixed(0)} KiB`;
}

function rate(bytesPerSec: number): string {
	if (bytesPerSec >= MIB) return `${(bytesPerSec / MIB).toFixed(2)} MiB/s`;
	return `${(bytesPerSec / KIB).toFixed(0)} KiB/s`;
}

/** Rates the calculator table is drawn at, in bytes/s. */
const RATE_POINTS = [
	25 * KIB,
	100 * KIB,
	500 * KIB,
	1 * MIB,
	5 * MIB,
	20 * MIB,
	100 * MIB,
];

/** Which bound a rate's raw size hits, if either. */
function clampNote(bytesPerSec: number): string {
	const raw = bytesPerSec * TARGET_CHUNK_SECONDS;
	if (raw < CHUNK_MIN) return "floor";
	if (raw > CHUNK_MAX) return "ceiling";
	return "";
}

export function ConnectionTab() {
	const t = useConnectionTest();
	const [uploadMib, setUploadMib] = useState("64");
	const [concurrency, setConcurrency] = useState("1");
	const [downloadMib, setDownloadMib] = useState("32");
	const [customMib, setCustomMib] = useState("1");

	const customRate = Number(customMib) * MIB;
	const customLength =
		Number.isFinite(customRate) && customRate > 0
			? nextChunkLength(customRate)
			: null;

	const pingMedian = (() => {
		if (!t.pings.length) return null;
		const sorted = [...t.pings].sort((a, b) => a - b);
		return sorted[Math.floor(sorted.length / 2)] ?? null;
	})();

	const busy = t.busy !== null;

	return (
		<div className="space-y-4">
			<p className="text-sm text-muted-foreground">
				Debug only. Moves real bytes over the same proxy path a chunked upload
				takes, and stores nothing. Chunks are discarded on arrival.
			</p>

			<div className="grid gap-4 lg:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2 text-base">
							<Radio className="size-4" /> Latency
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-3">
						<Button onClick={t.runPing} disabled={busy}>
							Ping ×5
						</Button>
						<div className="text-sm">
							{t.pings.length === 0 ? (
								<span className="text-muted-foreground">No samples yet.</span>
							) : (
								<>
									<div>
										Median{" "}
										<span className="font-mono">
											{pingMedian?.toFixed(0)} ms
										</span>
									</div>
									<div className="font-mono text-xs text-muted-foreground">
										{t.pings.map((p) => p.toFixed(0)).join(" · ")} ms
									</div>
								</>
							)}
						</div>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2 text-base">
							<Activity className="size-4" /> Download
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-3">
						<div className="flex items-center gap-2">
							<Select value={downloadMib} onValueChange={setDownloadMib}>
								<SelectTrigger className="w-28">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{["8", "32", "64"].map((m) => (
										<SelectItem key={m} value={m}>
											{m} MiB
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<Button
								onClick={() => t.runDownload(Number(downloadMib) * MIB)}
								disabled={busy}
							>
								Download
							</Button>
						</div>
						{t.download && (
							<div className="text-sm font-mono">
								{size(t.download.bytes)} in {t.download.seconds.toFixed(2)} s
								{" = "}
								{rate(t.download.bytes / t.download.seconds)}
								<div className="text-xs text-muted-foreground">
									first byte {t.download.firstByteMs.toFixed(0)} ms
								</div>
							</div>
						)}
					</CardContent>
				</Card>
			</div>

			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2 text-base">
						<Gauge className="size-4" /> Upload, chunk by chunk
					</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="flex flex-wrap items-center gap-2">
						<Select value={uploadMib} onValueChange={setUploadMib}>
							<SelectTrigger className="w-28">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{["16", "64", "128"].map((m) => (
									<SelectItem key={m} value={m}>
										{m} MiB
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Select value={concurrency} onValueChange={setConcurrency}>
							<SelectTrigger className="w-32">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{["1", "2", "3", "4", "5", "6"].map((c) => (
									<SelectItem key={c} value={c}>
										{c} in flight
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Button
							onClick={() =>
								t.runUpload(Number(uploadMib) * MIB, Number(concurrency))
							}
							disabled={busy}
						>
							Run
						</Button>
						{t.busy === "upload" && (
							<Button variant="outline" onClick={t.cancel}>
								Stop
							</Button>
						)}
					</div>

					{t.upload && (
						<div className="space-y-2 text-sm">
							<div className="font-mono">
								{size(t.upload.bytes)} · {t.upload.rows.length} chunks ·{" "}
								{t.upload.seconds.toFixed(1)} s ·{" "}
								{rate(t.upload.bytes / Math.max(t.upload.seconds, 0.001))}{" "}
								{t.upload.done ? "" : "(running)"}
							</div>
							<div className="max-h-96 overflow-auto rounded border">
								<table className="w-full text-xs font-mono">
									<thead className="sticky top-0 bg-card text-left text-muted-foreground">
										<tr>
											<th className="p-2">#</th>
											<th className="p-2">offset</th>
											<th className="p-2">length</th>
											<th className="p-2">took</th>
											<th className="p-2">this chunk</th>
											<th className="p-2">smoothed</th>
											<th className="p-2">next length</th>
										</tr>
									</thead>
									<tbody>
										{t.upload.rows.map((r) => (
											<tr key={r.n} className="border-t">
												<td className="p-2">{r.n}</td>
												<td className="p-2">{size(r.offset)}</td>
												<td className="p-2">{size(r.length)}</td>
												<td className="p-2">{r.seconds.toFixed(2)} s</td>
												<td className="p-2">{rate(r.chunkRate)}</td>
												<td className="p-2">{rate(r.smoothedRate)}</td>
												<td className="p-2">{size(r.nextLength)}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</div>
					)}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="text-base">
						How the chunk size is picked
					</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4 text-sm">
					<p>
						Each chunk is sized to take about{" "}
						<span className="font-mono">{TARGET_CHUNK_SECONDS} s</span> on the
						measured rate, clamped to{" "}
						<span className="font-mono">
							{size(CHUNK_MIN)} – {size(CHUNK_MAX)}
						</span>
						:
					</p>
					<pre className="rounded bg-muted p-3 font-mono text-xs">
						{`length = clamp(rate × ${TARGET_CHUNK_SECONDS} s, ${size(CHUNK_MIN)}, ${size(CHUNK_MAX)})`}
					</pre>
					<p className="text-muted-foreground">
						The rate is an exponential average of finished chunks (newest
						weighted 30%). A failed chunk halves it. The first chunks are{" "}
						{size(nextChunkLength(null))} until there is a measurement.
					</p>

					<div className="flex flex-wrap items-end gap-2">
						<div>
							<div className="mb-1 text-xs text-muted-foreground">
								Custom rate (MiB/s)
							</div>
							<Input
								className="w-32 font-mono"
								inputMode="decimal"
								value={customMib}
								onChange={(e) => setCustomMib(e.target.value)}
							/>
						</div>
						<div className="font-mono">
							→ {customLength === null ? "—" : size(customLength)}
						</div>
					</div>

					<div className="overflow-hidden rounded border">
						<table className="w-full text-xs font-mono">
							<thead className="bg-card text-left text-muted-foreground">
								<tr>
									<th className="p-2">rate</th>
									<th className="p-2">raw × {TARGET_CHUNK_SECONDS} s</th>
									<th className="p-2">chunk</th>
									<th className="p-2">bound</th>
								</tr>
							</thead>
							<tbody>
								{RATE_POINTS.map((r) => (
									<tr key={r} className="border-t">
										<td className="p-2">{rate(r)}</td>
										<td className="p-2">{size(r * TARGET_CHUNK_SECONDS)}</td>
										<td className="p-2">{size(nextChunkLength(r))}</td>
										<td className="p-2 text-muted-foreground">
											{clampNote(r)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</CardContent>
			</Card>

			{t.error && <p className="text-sm text-destructive">{t.error}</p>}
		</div>
	);
}
