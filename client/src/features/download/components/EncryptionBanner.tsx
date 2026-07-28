import { Globe, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import type { EncryptionMode } from "@/features/files/types";
import { cn } from "@/lib/cn";

export function EncryptionBanner({
	mode,
	hasKey,
}: {
	mode: EncryptionMode;
	hasKey: boolean;
}) {
	const config = (() => {
		if (mode === "none")
			return {
				icon: Globe,
				tone: "muted",
				text: "Public file. Anyone with this link can download it.",
			};
		if (mode === "client")
			return hasKey
				? {
						icon: ShieldAlert,
						tone: "warning",
						text: "End-to-end encrypted. It decrypts locally — the server never sees the contents or key.",
					}
				: {
						icon: ShieldX,
						tone: "danger",
						text: "End-to-end encrypted, but the key (#ek=) is missing. You need the complete share link.",
					};
		return hasKey
			? {
					icon: ShieldCheck,
					tone: "accent",
					text: "Server-side encrypted. The access key (?ek=) unlocks this download.",
				}
			: {
					icon: ShieldX,
					tone: "danger",
					text: "Server-side encrypted, but the access key (?ek=) is missing.",
				};
	})();

	const Icon = config.icon;
	return (
		<div
			className={cn(
				"flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm",
				config.tone === "warning" &&
					"border-warning/30 bg-warning/10 text-warning",
				config.tone === "accent" && "border-accent/30 bg-accent/10 text-accent",
				config.tone === "danger" &&
					"border-destructive/30 bg-destructive/10 text-destructive",
				config.tone === "muted" &&
					"border-border bg-secondary/30 text-muted-foreground",
			)}
		>
			<Icon className="mt-0.5 size-4 shrink-0" />
			<span>{config.text}</span>
		</div>
	);
}
