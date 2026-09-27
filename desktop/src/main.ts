import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

interface FsChange {
  path: string;
  kind: string;
}

const authStatus = document.querySelector<HTMLParagraphElement>("#auth-status")!;
const folderPath = document.querySelector<HTMLSpanElement>("#folder-path")!;
const changeLog = document.querySelector<HTMLUListElement>("#change-log")!;

document.querySelector<HTMLFormElement>("#server-form")!.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = document.querySelector<HTMLInputElement>("#server-url")!.value.trim();
  if (!url) return;
  await invoke("set_server_url", { url });
  authStatus.textContent = `Server set: ${url}`;
});

document.querySelector<HTMLFormElement>("#login-form")!.addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.querySelector<HTMLInputElement>("#username")!.value;
  const password = document.querySelector<HTMLInputElement>("#password")!.value;
  try {
    const result = await invoke<{ status: string }>("login", { username, password });
    authStatus.textContent = `Login: ${result.status}`;
  } catch (err) {
    authStatus.textContent = `Login failed: ${err}`;
  }
});

document.querySelector<HTMLButtonElement>("#pick-folder")!.addEventListener("click", async () => {
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
