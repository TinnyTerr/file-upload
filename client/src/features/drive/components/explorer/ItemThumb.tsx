import { Folder } from "lucide-react";
import { useState } from "react";
import { iconForType } from "@/features/files/lib/fileMeta";
import { cn } from "@/lib/cn";
import { useThumbnail } from "../../hooks/useThumbnail";
import type { DriveItem } from "../../lib/items";

/** Icon, or a real thumbnail when the file has one that can be fetched. */
export function ItemThumb({
	item,
	size = "sm",
	className,
}: {
	item: DriveItem;
	size?: "sm" | "lg";
	className?: string;
}) {
	const src = useThumbnail(item);
	const [failed, setFailed] = useState(false);

	const box = size === "lg" ? "size-16" : "size-5";
	const Icon =
		item.kind === "folder" ? Folder : iconForType(item.file.content_type);

	if (src && !failed) {
		return (
			<img
				src={src}
				alt=""
				loading="lazy"
				decoding="async"
				onError={() => setFailed(true)}
				className={cn(
					"shrink-0 rounded object-cover",
					size === "lg" ? "size-16" : "size-5",
					className,
				)}
			/>
		);
	}

	return (
		<Icon
			className={cn(
				"shrink-0",
				box,
				item.kind === "folder" ? "text-primary/80" : "text-muted-foreground",
				className,
			)}
		/>
	);
}
