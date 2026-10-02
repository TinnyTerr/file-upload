import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

interface FsChange {
	path: string;
	kind: string;
}

interface RemoteFile {
	id: number;
	original_filename: string;
	size_bytes: number;
	encryption_mode: string;
	access_key: string | null;
	links: { slug: string }[];
}

interface DownloadProgress {
	id: number;
	downloaded: number;
	total: number;
}

const authStatus =
	document.querySelector<HTMLParagraphElement>("#auth-status")!;
const folderPath = document.querySelector<HTMLSpanElement>("#folder-path")!;
const changeLog = document.querySelector<HTMLUListElement>("#change-log")!;
const downloadDirLabel =
	document.querySelector<HTMLSpanElement>("#download-dir")!;
const fileList = document.querySelector<HTMLUListElement>("#file-list")!;

let downloadDir: string | null = null;

async function refreshDownloadDirLabel() {
	downloadDir ??= await invoke<string>("default_download_dir");
	downloadDirLabel.textContent = downloadDir;
}

document
	.querySelector<HTMLButtonElement>("#pick-download-dir")!
	.addEventListener("click", async () => {
		const dir = await open({ directory: true, multiple: false });
		if (!dir || Array.isArray(dir)) return;
		downloadDir = dir;
		downloadDirLabel.textContent = downloadDir;
	});

document
	.querySelector<HTMLButtonElement>("#refresh-files")!
	.addEventListener("click", async () => {
		fileList.innerHTML = "<li>Loading…</li>";
		try {
			const res = await invoke<{ files: RemoteFile[] }>("list_files");
			renderFiles(res.files);
		} catch (err) {
			fileList.innerHTML = `<li>Failed to list files: ${err}</li>`;
		}
	});

function renderFiles(files: RemoteFile[]) {
	fileList.innerHTML = "";
	for (const file of files) {
		const item = document.createElement("li");
		item.dataset.fileId = String(file.id);
		const label = document.createElement("span");
		label.textContent = `${file.original_filename} (${(file.size_bytes / 1024 / 1024).toFixed(1)} MB)`;
		const progress = document.createElement("span");
		progress.className = "download-progress";
		const button = document.createElement("button");
		button.textContent = "Download";
		button.disabled =
			file.encryption_mode === "client" || file.encryption_mode === "sealed";
		if (button.disabled)
			progress.textContent = "browser-only (end-to-end encrypted)";
		button.addEventListener("click", async () => {
			const slug = file.links[0]?.slug;
			if (!slug) {
				progress.textContent = "no share link for this file";
				return;
			}
			button.disabled = true;
			progress.textContent = "starting…";
			try {
				const path = await invoke<string>("download_file", {
					id: file.id,
					slug,
					originalFilename: file.original_filename,
					encryptionMode: file.encryption_mode,
					accessKey: file.access_key,
					destDir: downloadDir,
				});
				progress.textContent = `saved to ${path}`;
			} catch (err) {
				progress.textContent = `failed: ${err}`;
				button.disabled = false;
			}
		});
		item.append(label, button, progress);
		fileList.append(item);
	}
}

await listen<DownloadProgress>("download-progress", (event) => {
	const { id, downloaded, total } = event.payload;
	const item = [...fileList.children].find(
		(li) => (li as HTMLElement).dataset.fileId === String(id),
	);
	const progress = item?.querySelector<HTMLSpanElement>(".download-progress");
	if (progress && total) {
		progress.textContent = `${Math.round((downloaded / total) * 100)}%`;
	}
});

void refreshDownloadDirLabel();

document
	.querySelector<HTMLFormElement>("#server-form")!
	.addEventListener("submit", async (e) => {
		e.preventDefault();
		const url = document
			.querySelector<HTMLInputElement>("#server-url")!
			.value.trim();
		if (!url) return;
		await invoke("set_server_url", { url });
		authStatus.textContent = `Server set: ${url}`;
	});

document
	.querySelector<HTMLFormElement>("#login-form")!
	.addEventListener("submit", async (e) => {
		e.preventDefault();
		const username =
			document.querySelector<HTMLInputElement>("#username")!.value;
		const password =
			document.querySelector<HTMLInputElement>("#password")!.value;
		try {
			const result = await invoke<{ status: string }>("login", {
				username,
				password,
			});
			authStatus.textContent = `Login: ${result.status}`;
		} catch (err) {
			authStatus.textContent = `Login failed: ${err}`;
		}
	});

document
	.querySelector<HTMLButtonElement>("#pick-folder")!
	.addEventListener("click", async () => {
		const dir = await open({ directory: true, multiple: false });
		if (!dir || Array.isArray(dir)) return;
		folderPath.textContent = dir;
		await invoke("watch_folder", { path: dir });
	});

await listen<FsChange>("fs-change", (event) => {
	const item = document.createElement("li");
	item.textContent = `${event.payload.kind}: ${event.payload.path}`;
	changeLog.prepend(item);
});
