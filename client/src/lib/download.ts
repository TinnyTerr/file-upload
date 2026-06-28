/** Trigger a browser download of a Blob with a given filename. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click has a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Read an encryption key from the URL fragment (#ek=) — client mode. */
export function readClientKeyFromHash(): string | null {
  const hash = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  return params.get("ek");
}

/** Read an access key from the query string (?ek=) — server mode. */
export function readServerKeyFromQuery(): string | null {
  return new URLSearchParams(window.location.search).get("ek");
}
