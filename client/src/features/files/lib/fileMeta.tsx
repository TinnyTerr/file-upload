import {
	FileArchive,
	FileAudio,
	FileCode,
	File as FileIcon,
	FileImage,
	FileText,
	FileVideo,
	type LucideIcon,
	ShieldAlert,
	ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { EncryptionMode } from "../types";

/** Pick an icon for a content type. */
export function iconForType(
	contentType: string | null | undefined,
): LucideIcon {
	const ct = (contentType ?? "").toLowerCase();
	if (ct.startsWith("image/")) return FileImage;
	if (ct.startsWith("video/")) return FileVideo;
	if (ct.startsWith("audio/")) return FileAudio;
	if (
		ct.includes("zip") ||
		ct.includes("tar") ||
		ct.includes("compressed") ||
		ct.includes("x-7z")
	)
		return FileArchive;
	if (
		ct.includes("json") ||
		ct.includes("javascript") ||
		ct.includes("xml") ||
		ct.includes("html")
	)
		return FileCode;
	if (ct.startsWith("text/")) return FileText;
	if (ct.includes("pdf")) return FileText;
	return FileIcon;
}

/** `inherited` means the key lives on a folder further up rather than on this
 * row, which changes what "change the encryption" would even act on -- worth a
 * visual distinction, not just a tooltip. */
export function EncryptionBadge({
	mode,
	inherited = false,
}: {
	mode: EncryptionMode;
	inherited?: boolean;
}) {
	// The variants all set `border-transparent`, so an inherited badge has to
	// re-colour the border for the dash to be visible at all.
	const dashed = inherited ? "border-dashed border-current/50" : undefined;
	if (mode === "sealed")
		return (
			<Badge variant="warning" className={dashed}>
				<ShieldAlert /> sealed
			</Badge>
		);
	if (mode === "client")
		return (
			<Badge variant="warning" className={dashed}>
				<ShieldAlert /> e2e
			</Badge>
		);
	if (mode === "server")
		return (
			<Badge variant="accent" className={dashed}>
				<ShieldCheck /> server
			</Badge>
		);
	return null;
}
