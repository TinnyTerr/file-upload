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

export function EncryptionBadge({ mode }: { mode: EncryptionMode }) {
	if (mode === "client")
		return (
			<Badge variant="warning">
				<ShieldAlert /> e2e
			</Badge>
		);
	if (mode === "server")
		return (
			<Badge variant="accent">
				<ShieldCheck /> server
			</Badge>
		);
	return null;
}
