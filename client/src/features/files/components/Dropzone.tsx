import { UploadCloud } from "lucide-react";
import { useRef, useState } from "react";
import { readDroppedItems } from "@/features/drive/lib/dropEntries";
import { cn } from "@/lib/cn";

/** Drag-and-drop or click-to-pick file selector. */
export function Dropzone({
	onFiles,
	multiple = true,
	directory = false,
	hint,
}: {
	onFiles: (files: File[], isTree: boolean) => void;
	multiple?: boolean;
	directory?: boolean;
	hint?: string;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [dragging, setDragging] = useState(false);
	// dragenter/dragleave fire per element and bubble, so leaving a child (any
	// icon or text node inside the zone) briefly looks identical to leaving the
	// zone itself. A depth counter is what tells the two apart.
	const dragDepth = useRef(0);

	const pick = (list: FileList | null) => {
		if (!list || !list.length) return;
		onFiles(Array.from(list), false);
	};

	// webkitdirectory/directory are non-standard; a typed record avoids JSX
	// excess-property checks while still emitting the attributes.
	const dirProps: Record<string, string> = directory
		? { webkitdirectory: "", directory: "" }
		: {};

	return (
		<div
			role="button"
			tabIndex={0}
			onClick={() => inputRef.current?.click()}
			onKeyDown={(e) =>
				(e.key === "Enter" || e.key === " ") && inputRef.current?.click()
			}
			onDragEnter={(e) => {
				e.preventDefault();
				dragDepth.current += 1;
				setDragging(true);
			}}
			onDragOver={(e) => e.preventDefault()}
			onDragLeave={() => {
				dragDepth.current -= 1;
				if (dragDepth.current <= 0) {
					dragDepth.current = 0;
					setDragging(false);
				}
			}}
			onDrop={(e) => {
				e.preventDefault();
				dragDepth.current = 0;
				setDragging(false);
				// Dropping a folder needs webkitGetAsEntry to see inside it --
				// DataTransfer.files flattens a directory to nothing.
				if (directory) {
					const items = Array.from(e.dataTransfer.items);
					const files = Array.from(e.dataTransfer.files);
					void readDroppedItems(items, files).then((payload) =>
						onFiles(payload.files, payload.isTree),
					);
					return;
				}
				pick(e.dataTransfer.files);
			}}
			className={cn(
				"flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-all duration-200",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				dragging
					? "border-primary bg-primary/10 scale-[1.01]"
					: "border-border bg-secondary/20 hover:border-primary/50 hover:bg-secondary/40",
			)}
		>
			<div className="flex size-12 items-center justify-center rounded-xl bg-brand-gradient shadow-lg shadow-primary/20">
				<UploadCloud className="size-6 text-white" />
			</div>
			<p className="text-sm font-medium">
				{directory
					? "Drop a folder or click to choose — its whole file tree uploads as one bundle"
					: multiple
						? "Drop one or more files or click to browse"
						: "Drop a file or click to browse"}
			</p>
			{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
			<input
				ref={inputRef}
				type="file"
				hidden
				multiple={multiple}
				{...dirProps}
				onChange={(e) => {
					if (directory) onFiles(Array.from(e.target.files ?? []), true);
					else pick(e.target.files);
					e.target.value = "";
				}}
			/>
		</div>
	);
}
