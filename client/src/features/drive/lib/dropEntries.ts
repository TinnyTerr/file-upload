/**
 * Reading a dropped OS *folder*.
 *
 * `DataTransfer.files` flattens a dropped directory to nothing — the only way
 * to see inside one is `webkitGetAsEntry`, which is non-standard but universal
 * (it is also what the `webkitdirectory` picker input relies on, so the app
 * already depends on it).
 *
 * The returned `File`s carry a synthetic `webkitRelativePath`, which is exactly
 * what `useDriveTreeUpload`'s `folderChain()` already parses — so a dropped
 * folder and a picked folder take the identical code path from here on.
 */

interface FileSystemEntryLike {
	isFile: boolean;
	isDirectory: boolean;
	name: string;
	file?: (cb: (file: File) => void, err: (e: unknown) => void) => void;
	createReader?: () => {
		readEntries: (
			cb: (entries: FileSystemEntryLike[]) => void,
			err: (e: unknown) => void,
		) => void;
	};
}

/** Depth bound, matching the server's `MAX_DEPTH`. A symlink loop on the
 * dropping machine would otherwise recurse until the tab dies. */
const MAX_DEPTH = 10;

function withPath(file: File, path: string): File {
	// `webkitRelativePath` is read-only on File, so define it rather than assign.
	Object.defineProperty(file, "webkitRelativePath", {
		value: path,
		configurable: true,
	});
	return file;
}

function readEntry(entry: FileSystemEntryLike): Promise<File | null> {
	return new Promise((resolve) => {
		if (!entry.file) {
			resolve(null);
			return;
		}
		entry.file(
			(f) => resolve(f),
			() => resolve(null),
		);
	});
}

/** `readEntries` returns at most ~100 per call and signals completion with an
 * empty batch, so it has to be drained in a loop. */
function readAllEntries(
	reader: NonNullable<
		ReturnType<NonNullable<FileSystemEntryLike["createReader"]>>
	>,
): Promise<FileSystemEntryLike[]> {
	return new Promise((resolve) => {
		const all: FileSystemEntryLike[] = [];
		const step = () =>
			reader.readEntries(
				(batch) => {
					if (!batch.length) {
						resolve(all);
						return;
					}
					all.push(...batch);
					step();
				},
				() => resolve(all),
			);
		step();
	});
}

async function walk(
	entry: FileSystemEntryLike,
	prefix: string,
	depth: number,
	out: File[],
): Promise<void> {
	if (depth > MAX_DEPTH) return;
	const path = prefix ? `${prefix}/${entry.name}` : entry.name;
	if (entry.isFile) {
		const file = await readEntry(entry);
		if (file) out.push(withPath(file, path));
		return;
	}
	if (entry.isDirectory && entry.createReader) {
		const children = await readAllEntries(entry.createReader());
		for (const child of children) await walk(child, path, depth + 1, out);
	}
}

export interface DroppedPayload {
	files: File[];
	/** True when at least one dropped item was a directory, which decides
	 * whether the tree-recreating upload path is used. */
	isTree: boolean;
}

/**
 * Turns a drop into a flat `File[]`, expanding any dropped directories.
 *
 * `items` must be captured synchronously in the drop handler — the
 * `DataTransfer` is neutered as soon as the event handler returns.
 */
export async function readDroppedItems(
	items: DataTransferItem[],
	fallbackFiles: File[],
): Promise<DroppedPayload> {
	const entries = items
		.map((it) =>
			"webkitGetAsEntry" in it
				? (it.webkitGetAsEntry() as unknown as FileSystemEntryLike | null)
				: null,
		)
		.filter((e): e is FileSystemEntryLike => e !== null);

	if (!entries.length) return { files: fallbackFiles, isTree: false };

	const isTree = entries.some((e) => e.isDirectory);
	if (!isTree) return { files: fallbackFiles, isTree: false };

	const out: File[] = [];
	for (const entry of entries) await walk(entry, "", 0, out);
	return { files: out, isTree: true };
}
