import { formatBytes, percent as pctOf } from "@/lib/bytes";
import { cn } from "@/lib/cn";

const CHART_COLORS = [
	"var(--chart-1)",
	"var(--chart-2)",
	"var(--chart-3)",
	"var(--chart-4)",
	"var(--chart-5)",
];

/** Donut showing used vs free against a cap. */
export function StorageRing({
	used,
	total,
	size = 140,
}: {
	used: number;
	total: number;
	size?: number;
}) {
	const pct = pctOf(used, total);
	const r = size / 2 - 12;
	const c = 2 * Math.PI * r;
	const dash = (pct / 100) * c;

	return (
		<div
			className="relative inline-flex items-center justify-center"
			style={{ width: size, height: size }}
		>
			<svg width={size} height={size} className="-rotate-90">
				<circle
					cx={size / 2}
					cy={size / 2}
					r={r}
					fill="none"
					stroke="var(--secondary)"
					strokeWidth={10}
				/>
				<circle
					cx={size / 2}
					cy={size / 2}
					r={r}
					fill="none"
					stroke="url(#ringGrad)"
					strokeWidth={10}
					strokeLinecap="round"
					strokeDasharray={`${dash} ${c - dash}`}
					className="transition-[stroke-dasharray] duration-700 ease-out"
				/>
				<defs>
					<linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
						<stop offset="0%" stopColor="var(--brand-from)" />
						<stop offset="100%" stopColor="var(--brand-to)" />
					</linearGradient>
				</defs>
			</svg>
			<div className="absolute flex flex-col items-center">
				<span className="text-lg font-bold">{pct.toFixed(0)}%</span>
				<span className="text-[11px] text-muted-foreground">
					{formatBytes(used)}
				</span>
			</div>
		</div>
	);
}

export interface BarDatum {
	label: string;
	value: number;
	hint?: string;
}

/** Horizontal bar list, values normalized to the max. */
export function BarList({
	data,
	formatValue,
}: {
	data: BarDatum[];
	formatValue?: (v: number) => string;
}) {
	const max = Math.max(1, ...data.map((d) => d.value));
	if (!data.length)
		return (
			<p className="py-4 text-center text-sm text-muted-foreground">No data</p>
		);
	return (
		<div className="space-y-2">
			{data.map((d, i) => (
				<div key={`${d.label}-${i}`} className="space-y-1">
					<div className="flex items-center justify-between gap-2 text-xs">
						<span
							className="truncate text-foreground"
							title={d.hint ?? d.label}
						>
							{d.label}
						</span>
						<span className="shrink-0 text-muted-foreground">
							{formatValue ? formatValue(d.value) : d.value}
						</span>
					</div>
					<div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
						<div
							className="h-full rounded-full transition-[width] duration-500"
							style={{
								width: `${(d.value / max) * 100}%`,
								backgroundColor: CHART_COLORS[i % CHART_COLORS.length],
							}}
						/>
					</div>
				</div>
			))}
		</div>
	);
}

/** Status count pills. */
export function StatusPills({ counts }: { counts: Record<string, number> }) {
	const entries = Object.entries(counts);
	if (!entries.length) return null;
	return (
		<div className="flex flex-wrap gap-2">
			{entries.map(([key, count], i) => (
				<div
					key={key}
					className="flex items-center gap-2 rounded-full border border-border bg-secondary/30 px-3 py-1 text-xs"
				>
					<span
						className="size-2 rounded-full"
						style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
					/>
					<span className="capitalize text-muted-foreground">
						{key.replace(/_/g, " ")}
					</span>
					<span className="font-semibold">{count}</span>
				</div>
			))}
		</div>
	);
}

export interface Segment {
	label: string;
	value: number;
}

/** Donut chart with a legend, built from labelled values. */
export function Donut({
	data,
	size = 132,
	unit,
}: {
	data: Segment[];
	size?: number;
	unit?: string;
}) {
	const items = data.filter((d) => d.value > 0);
	const total = items.reduce((n, d) => n + d.value, 0);
	if (total === 0)
		return (
			<p className="py-6 text-center text-sm text-muted-foreground">No data</p>
		);

	const r = size / 2 - 10;
	const c = 2 * Math.PI * r;
	let offset = 0;

	return (
		<div className="flex items-center gap-4">
			<div className="relative shrink-0" style={{ width: size, height: size }}>
				<svg width={size} height={size} className="-rotate-90">
					{items.map((d, i) => {
						const frac = d.value / total;
						const dash = frac * c;
						const seg = (
							<circle
								key={d.label}
								cx={size / 2}
								cy={size / 2}
								r={r}
								fill="none"
								stroke={CHART_COLORS[i % CHART_COLORS.length]}
								strokeWidth={12}
								strokeDasharray={`${dash} ${c - dash}`}
								strokeDashoffset={-offset}
								className="transition-all duration-500"
							/>
						);
						offset += dash;
						return seg;
					})}
				</svg>
				<div className="absolute inset-0 flex flex-col items-center justify-center">
					<span className="text-lg font-bold">{total.toLocaleString()}</span>
					{unit && (
						<span className="text-[11px] text-muted-foreground">{unit}</span>
					)}
				</div>
			</div>
			<ul className="min-w-0 flex-1 space-y-1 text-xs">
				{items.map((d, i) => (
					<li key={d.label} className="flex items-center justify-between gap-2">
						<span className="flex min-w-0 items-center gap-1.5">
							<span
								className="size-2 shrink-0 rounded-full"
								style={{
									backgroundColor: CHART_COLORS[i % CHART_COLORS.length],
								}}
							/>
							<span
								className="truncate capitalize text-muted-foreground"
								title={d.label}
							>
								{d.label.replace(/_/g, " ")}
							</span>
						</span>
						<span className="shrink-0 font-medium">
							{d.value.toLocaleString()} ·{" "}
							{((d.value / total) * 100).toFixed(0)}%
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

/** Single horizontal stacked bar with a legend (e.g. storage allocation). */
export function StackedBar({
	data,
	formatValue,
}: {
	data: Segment[];
	formatValue?: (v: number) => string;
}) {
	const items = data.filter((d) => d.value > 0);
	const total = items.reduce((n, d) => n + d.value, 0);
	if (total === 0)
		return (
			<p className="py-4 text-center text-sm text-muted-foreground">No data</p>
		);
	return (
		<div className="space-y-3">
			<div className="flex h-3 w-full overflow-hidden rounded-full bg-secondary">
				{items.map((d, i) => (
					<div
						key={d.label}
						className="h-full transition-[width] duration-500"
						style={{
							width: `${(d.value / total) * 100}%`,
							backgroundColor: CHART_COLORS[i % CHART_COLORS.length],
						}}
						title={`${d.label}: ${formatValue ? formatValue(d.value) : d.value}`}
					/>
				))}
			</div>
			<ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
				{items.map((d, i) => (
					<li key={d.label} className="flex items-center gap-1.5">
						<span
							className="size-2 shrink-0 rounded-full"
							style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
						/>
						<span className="truncate capitalize text-muted-foreground">
							{d.label.replace(/_/g, " ")}
						</span>
						<span className="ml-auto font-medium">
							{formatValue ? formatValue(d.value) : d.value}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

/** Per-user storage bars (used vs quota). */
export function QuotaBars({
	rows,
}: {
	rows: { username: string; used_bytes: number; quota_bytes: number | null }[];
}) {
	if (!rows.length)
		return (
			<p className="py-4 text-center text-sm text-muted-foreground">No users</p>
		);
	return (
		<div className="space-y-2.5">
			{rows.map((row) => {
				const pct = row.quota_bytes
					? pctOf(row.used_bytes, row.quota_bytes)
					: 0;
				const tone =
					pct >= 90
						? "bg-destructive"
						: pct >= 70
							? "bg-warning"
							: "bg-brand-gradient";
				return (
					<div key={row.username} className="space-y-1">
						<div className="flex items-center justify-between text-xs">
							<span className="truncate">{row.username}</span>
							<span className="text-muted-foreground">
								{formatBytes(row.used_bytes)}
								{row.quota_bytes ? ` / ${formatBytes(row.quota_bytes)}` : ""}
							</span>
						</div>
						<div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
							<div
								className={cn(
									"h-full rounded-full transition-[width] duration-500",
									tone,
								)}
								style={{ width: `${pct}%` }}
							/>
						</div>
					</div>
				);
			})}
		</div>
	);
}
