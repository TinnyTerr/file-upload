# API reference

Upload, download, and manage files programmatically.

This document is the single source of truth for the public API. The in-app
reference at `/api-docs` renders this exact file, and `GET /api/docs.md` serves
it raw for LLM and tooling consumption. Base URLs in the examples below are
rewritten to this server's own origin as the document is served, so every
snippet is copy-pasteable as-is.

## Getting started

All API requests authenticate with a Bearer token in the `Authorization`
header. API keys require the `can_use_api_keys` permission and are created from
the **API keys** page.

```
Authorization: Bearer <your-api-key>
```

**IP binding.** A key binds to the first IP address it is used from. If you
change networks, reset the binding from the API keys page. You can also pre-bind
a key to a specific CIDR or IP.

**Base URL.**

```
{{BASE_URL}}
```

**Content type.** Uploads use `multipart/form-data`. All other request bodies
are `application/json`. Responses are always `application/json` unless you are
downloading raw file content.

## Files

### GET /api/files/ — List files

Returns all files owned by or shared with the authenticated user.

```bash
curl "{{BASE_URL}}/api/files/" \
  -H "Authorization: Bearer <your-api-key>"
```

```python
import requests

resp = requests.get(
    "{{BASE_URL}}/api/files/",
    headers={"Authorization": "Bearer <your-api-key>"}
)
files = resp.json()["files"]
for f in files:
    print(f["original_filename"], f["size_bytes"])
```

```javascript
const res = await fetch("{{BASE_URL}}/api/files/", {
  headers: { "Authorization": "Bearer <your-api-key>" }
});
const { files } = await res.json();
console.log(files);
```

Response (200 OK):

```json
{
  "files": [
    {
      "id": 1,
      "original_filename": "report.pdf",
      "size_bytes": 204800,
      "encryption_mode": "none",
      "source_type": "upload",
      "created_at": "2026-01-15T10:30:00Z",
      "links": [
        {
          "id": 1,
          "slug": "ab12cd34",
          "use_count": 0,
          "max_uses": null,
          "expires_at": null,
          "active": true,
          "hide_uploader": false
        }
      ]
    }
  ]
}
```

### POST /api/files/upload — Upload a file

Upload a file using `multipart/form-data`. Returns a shareable link and
metadata.

Form fields:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `file` | file | yes | The file binary. |
| `original_filename` | string | yes | Filename to display to recipients. |
| `encryption_mode` | string | no | `none` \| `server` \| `client` (default: `none`). |
| `max_uses` | integer | no | Maximum number of downloads before the link is exhausted. |
| `expires_in_seconds` | integer | no | TTL in seconds from now. |
| `compress` | boolean | no | Compress the file before storing (default `false`). |
| `randomize_filename` | boolean | no | Store under a random name (default `false`). |
| `directory_id` | integer | no | Upload straight into a folder, at any depth. |

**A folder decides the encryption.** When `directory_id` is set, the file takes
that folder's effective encryption and `encryption_mode` is ignored — as are
`compress` and the lifecycle fields, which the folder also fixes. Uploading into
an end-to-end folder therefore only works from a client that holds its key.

```bash
curl -X POST "{{BASE_URL}}/api/files/upload" \
  -H "Authorization: Bearer <your-api-key>" \
  -F "file=@./report.pdf" \
  -F "original_filename=report.pdf" \
  -F "encryption_mode=none"
```

```python
import requests

with open("report.pdf", "rb") as f:
    resp = requests.post(
        "{{BASE_URL}}/api/files/upload",
        headers={"Authorization": "Bearer <your-api-key>"},
        files={"file": f},
        data={
            "original_filename": "report.pdf",
            "encryption_mode": "none",
        },
    )
print(resp.json())
```

```javascript
import { createReadStream } from "fs";
import FormData from "form-data";
import fetch from "node-fetch";

const form = new FormData();
form.append("file", createReadStream("report.pdf"));
form.append("original_filename", "report.pdf");
form.append("encryption_mode", "none");

const res = await fetch("{{BASE_URL}}/api/files/upload", {
  method: "POST",
  headers: { "Authorization": "Bearer <your-api-key>", ...form.getHeaders() },
  body: form,
});
console.log(await res.json());
```

Response (200 OK):

```json
{
  "id": 1,
  "slug": "ab12cd34",
  "url": "{{BASE_URL}}/api/file/ab12cd34",
  "raw_url": "{{BASE_URL}}/api/file/ab12cd34/raw",
  "encryption_mode": "none",
  "access_key": null
}
```

### DELETE /api/files/{file_id} — Delete a file

Permanently deletes the file and all its share links. Requires the `can_delete`
permission.

Path parameters:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `file_id` | integer | yes | The numeric file ID. |

```bash
curl -X DELETE "{{BASE_URL}}/api/files/1" \
  -H "Authorization: Bearer <your-api-key>"
```

```python
requests.delete(
    "{{BASE_URL}}/api/files/1",
    headers={"Authorization": "Bearer <your-api-key>"}
)
```

```javascript
await fetch("{{BASE_URL}}/api/files/1", {
  method: "DELETE",
  headers: { "Authorization": "Bearer <your-api-key>" }
});
```

Response (200 OK):

```json
{ "status": "deleted" }
```

### PATCH /api/files/{file_id} — Rename a file

Changes the display filename. Any path separators are stripped — the name ends
up in `Content-Disposition` and in ZIP member names.

Body:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `original_filename` | string | yes | New filename, max 512 characters. |

```bash
curl -X PATCH "{{BASE_URL}}/api/files/1" \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"original_filename": "quarterly-report.pdf"}'
```

```python
requests.patch(
    "{{BASE_URL}}/api/files/1",
    headers={"Authorization": "Bearer <your-api-key>"},
    json={"original_filename": "quarterly-report.pdf"}
)
```

```javascript
await fetch("{{BASE_URL}}/api/files/1", {
  method: "PATCH",
  headers: {
    "Authorization": "Bearer <your-api-key>",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({ original_filename: "quarterly-report.pdf" })
});
```

Returns the updated file object, in the same shape as `GET /api/files/`.

### PATCH /api/files/{file_id}/move — Move a file

Moves the file into a folder, or out to the root.

Body:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `directory_id` | integer or null | yes | Target folder, or `null` for the root. |

A moved file keeps the key its bytes are already under — moving is not
re-encryption. Use `PATCH /api/files/{file_id}/encryption` afterwards to adopt
the destination folder's key. Moving a file out to the root requires ownership,
not merely edit rights on its folder.

```bash
curl -X PATCH "{{BASE_URL}}/api/files/1/move" \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"directory_id": 7}'
```

```python
requests.patch(
    "{{BASE_URL}}/api/files/1/move",
    headers={"Authorization": "Bearer <your-api-key>"},
    json={"directory_id": 7}
)
```

```javascript
await fetch("{{BASE_URL}}/api/files/1/move", {
  method: "PATCH",
  headers: {
    "Authorization": "Bearer <your-api-key>",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({ directory_id: 7 })
});
```

### POST /api/files/{file_id}/copy — Duplicate a file

Makes a second file pointing at the same stored bytes, in the folder you name.
Nothing is uploaded and no extra disk is used — storage is content-addressed, so
a copy is a reference count going up by one. Your logical quota is still charged
for it, exactly as `GET /api/files/` reports sizes before de-duplication.

Requires `can_upload`, plus edit rights on the source file and on the
destination folder.

Body:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `directory_id` | integer or null | no | Target folder; omit or `null` for the root. |

The copy carries the *resolved* encryption of the source. If the destination
resolves to the same key, the copy inherits from it; otherwise the copy becomes
its own break point holding a materialised key, because inheriting would label
the bytes with a key that doesn't describe them. A fresh share link is minted.

Copying **into** a `client` or `sealed` folder is refused with `409` — the
server holds no key for such a folder, so it cannot decide the copy's
inheritance without lying about it. Copying a `client` or `sealed` file *out* of
one is fine: the bytes and the key you hold are unchanged.

Returns the new file, in the same shape as `GET /api/files/`.

```bash
curl -X POST "{{BASE_URL}}/api/files/1/copy" \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"directory_id": 7}'
```

```python
requests.post(
    "{{BASE_URL}}/api/files/1/copy",
    headers={"Authorization": "Bearer <your-api-key>"},
    json={"directory_id": 7}
)
```

```javascript
await fetch("{{BASE_URL}}/api/files/1/copy", {
  method: "POST",
  headers: {
    "Authorization": "Bearer <your-api-key>",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({ directory_id: 7 })
});
```

### GET /api/files/{file_id}/content — Download your own file

The owner's read of their own bytes. Unlike `GET /api/file/{slug}/raw`, this
consumes no share-link use and needs no link to exist at all.

Returns plaintext for `none` and `server` files (decompressing and decrypting as
needed), and the raw encrypted container for `client` and `sealed` ones — which
is exactly what a client holding the key needs in order to decrypt it.

```bash
curl -L -O -J "{{BASE_URL}}/api/files/1/content" \
  -H "Authorization: Bearer <your-api-key>"
```

```python
with requests.get(
    "{{BASE_URL}}/api/files/1/content",
    headers={"Authorization": "Bearer <your-api-key>"},
    stream=True,
) as r:
    r.raise_for_status()
    with open("out.bin", "wb") as f:
        for chunk in r.iter_content(chunk_size=8192):
            f.write(chunk)
```

```javascript
const res = await fetch("{{BASE_URL}}/api/files/1/content", {
  headers: { "Authorization": "Bearer <your-api-key>" }
});
const bytes = new Uint8Array(await res.arrayBuffer());
```

### PATCH /api/files/{file_id}/encryption — Change a file's encryption

Switches a file between `none` and `server`, or makes it follow its folder
again. This physically rewrites the stored bytes, so it is a slow request for a
large file.

Body — pass exactly one of:

| Name | Type | Description |
| --- | --- | --- |
| `mode` | `"none"` or `"server"` | Give this file its own encryption. `server` mints a fresh key. |
| `adopt_parent` | boolean | Drop the file's own key and follow its folder's chain again. |
| `password` | string | Optional, only with `mode: "server"`: use this password as the `?ek=` secret instead of a random token. Minimum 8 characters. |

`client` and `sealed` files are refused with 409 — the server holds no key for
them, so it cannot rewrite them. See *Converting to and from end-to-end
encryption* below.

```bash
curl -X PATCH "{{BASE_URL}}/api/files/1/encryption" \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"mode": "server"}'
```

```python
resp = requests.patch(
    "{{BASE_URL}}/api/files/1/encryption",
    headers={"Authorization": "Bearer <your-api-key>"},
    json={"mode": "server"}
)
print(resp.json()["access_key"])
```

```javascript
const res = await fetch("{{BASE_URL}}/api/files/1/encryption", {
  method: "PATCH",
  headers: {
    "Authorization": "Bearer <your-api-key>",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({ mode: "server" })
});
const { access_key } = await res.json();
```

Returns the updated file object plus `access_key` — the `?ek=` value to append
to its download URLs.

### PUT /api/files/{file_id}/access — Change the access secret

Swaps the `?ek=` secret without re-encrypting anything. Send a password to
choose your own, or an empty body to go back to a random token. Changing the
secret clears the guess counter on every one of the file's links.

Body:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `password` | string | no | 8–256 characters. Omit to mint a random token instead. |

```bash
curl -X PUT "{{BASE_URL}}/api/files/1/access" \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"password": "correct horse battery"}'
```

Response (200 OK):

```json
{ "id": 1, "access_key": "correct horse battery", "password_locked": true }
```

Only `server`-mode files have an access secret; anything else is refused.

### POST /api/files/{file_id}/seal — Seal & forget

Encrypts an already-uploaded file with a fresh key, returns that key **once**,
and keeps no copy of it. From this point the server cannot read the file: it
behaves exactly like a `client`-mode one, and the key must travel in the URL
*fragment* (`#ek=`), never as a `?ek=` query parameter.

Body:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `password` | string | no | Derive the key from this password instead of a random one, so there is something to remember rather than something to write down. |

```bash
curl -X POST "{{BASE_URL}}/api/files/1/seal" \
  -H "Authorization: Bearer <your-api-key>"
```

```python
resp = requests.post(
    "{{BASE_URL}}/api/files/1/seal",
    headers={"Authorization": "Bearer <your-api-key>"}
)
key = resp.json()["key"]   # store this now; it is never shown again
```

```javascript
const res = await fetch("{{BASE_URL}}/api/files/1/seal", {
  method: "POST",
  headers: { "Authorization": "Bearer <your-api-key>" }
});
const { key } = await res.json();  // store this now
```

Response (200 OK) — the file object, plus:

```json
{
  "key": "IY0m5v1oQ...",
  "key_is_password": false,
  "seal_salt": null,
  "seal_kdf": null
}
```

With a password, `seal_salt` and `seal_kdf` are published (a salt is not a
secret) so a client can rederive the key. **The honest caveat:** the key passed
through this server's memory for the duration of this one request. It is never
written to disk or to logs, but "an attacker controls the server at the moment
of sealing" is a threat true end-to-end encryption resists and this does not.

### POST /api/files/{file_id}/e2e-conversion — Commit an end-to-end conversion

Going into or out of end-to-end encryption is a client-side operation: download,
decrypt or re-encrypt locally, then upload the result as a new file. This
endpoint commits that swap — it deletes the file that was replaced and records
the transition in the audit log, so it is visible exactly when previously
end-to-end content stopped being end-to-end.

`{file_id}` is the **new** file.

Body:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `replaced_file_id` | integer | yes | The old file, deleted on success. |

At least one of the two files must be `client` or `sealed`, otherwise the
request is refused with 400 — this endpoint is not a general "delete that one
too". Deleting requires `can_delete` and ownership of the replaced file.

```bash
curl -X POST "{{BASE_URL}}/api/files/9/e2e-conversion" \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"replaced_file_id": 1}'
```

Expected sequence: upload the new file → confirm it succeeded → call this. Both
files exist briefly, on purpose; the old one dies only once the replacement is
durable.

## Links

### POST /api/files/{file_id}/links — Create a share link

Mints a new share link for a file. You can create multiple links with different
limits.

Path parameters:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `file_id` | integer | yes | The numeric file ID. |

Request body (JSON):

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `max_uses` | integer \| null | no | Maximum downloads. `null` = unlimited. |
| `expires_in_seconds` | integer \| null | no | TTL in seconds from now. |
| `hide_uploader` | boolean | no | If true, the uploader's name and avatar are hidden from recipients (default `false`). |

```bash
curl -X POST "{{BASE_URL}}/api/files/1/links" \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"max_uses": 10, "expires_in_seconds": 86400, "hide_uploader": false}'
```

```python
resp = requests.post(
    "{{BASE_URL}}/api/files/1/links",
    headers={"Authorization": "Bearer <your-api-key>"},
    json={"max_uses": 10, "expires_in_seconds": 86400}
)
print(resp.json()["url"])
```

```javascript
const res = await fetch("{{BASE_URL}}/api/files/1/links", {
  method: "POST",
  headers: {
    "Authorization": "Bearer <your-api-key>",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ max_uses: 10, expires_in_seconds: 86400 }),
});
console.log(await res.json());
```

Response (200 OK):

```json
{
  "slug": "ab12cd34",
  "url": "{{BASE_URL}}/api/file/ab12cd34",
  "raw_url": "{{BASE_URL}}/api/file/ab12cd34/raw",
  "encryption_mode": "none",
  "access_key": null
}
```

### PATCH /api/links/{link_id} — Edit a share link

Update a link's limits, active state, or uploader visibility. Only supply fields
you want to change.

Request body (JSON):

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `max_uses` | integer \| null | no | New download cap. `null` = unlimited. |
| `expires_in_seconds` | integer \| null | no | New TTL from now. |
| `active` | boolean | no | Enable or disable the link. |
| `hide_uploader` | boolean | no | Toggle uploader visibility for recipients. |

```bash
curl -X PATCH "{{BASE_URL}}/api/links/1" \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"active": false}'
```

```python
requests.patch(
    "{{BASE_URL}}/api/links/1",
    headers={"Authorization": "Bearer <your-api-key>"},
    json={"active": False}
)
```

```javascript
await fetch("{{BASE_URL}}/api/links/1", {
  method: "PATCH",
  headers: {
    "Authorization": "Bearer <your-api-key>",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ active: false }),
});
```

Response (200 OK):

```json
{ "status": "updated" }
```

### DELETE /api/links/{link_id} — Delete a share link

Permanently removes a share link. Existing holders of the URL can no longer
download.

```bash
curl -X DELETE "{{BASE_URL}}/api/links/1" \
  -H "Authorization: Bearer <your-api-key>"
```

```python
requests.delete(
    "{{BASE_URL}}/api/links/1",
    headers={"Authorization": "Bearer <your-api-key>"}
)
```

```javascript
await fetch("{{BASE_URL}}/api/links/1", {
  method: "DELETE",
  headers: { "Authorization": "Bearer <your-api-key>" }
});
```

Response (200 OK):

```json
{ "status": "deleted" }
```

## Public download

### GET /api/file/{slug}/info — File metadata

Fetch metadata for a public file link without consuming a download or requiring
auth.

Query parameters:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `ek` | string | no | Server-mode access key (required for server-encrypted files). |

```bash
curl "{{BASE_URL}}/api/file/ab12cd34/info"
```

```python
resp = requests.get("{{BASE_URL}}/api/file/ab12cd34/info")
info = resp.json()
print(info["original_filename"], info["size_bytes"])
```

```javascript
const res = await fetch("{{BASE_URL}}/api/file/ab12cd34/info");
console.log(await res.json());
```

Response (200 OK):

```json
{
  "original_filename": "report.pdf",
  "content_type": "application/pdf",
  "size_bytes": 204800,
  "encryption_mode": "none",
  "compressed": false,
  "use_count": 2,
  "max_uses": 10,
  "expires_at": null,
  "uploader": { "username": "alice", "has_avatar": true, "user_id": 5 },
  "already_saved": false
}
```

`uploader` is `null` when the link sets `hide_uploader`.

### GET /api/file/{slug}/raw — Download file

Download the raw file content. For server-encrypted files, include the access
key. For client-encrypted files, you receive ciphertext that must be decrypted
locally.

Query parameters:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `ek` | string | no | Required for server-encrypted files. The access key returned by the upload or link creation response. |

```bash
# Unencrypted
curl -L -O "{{BASE_URL}}/api/file/ab12cd34/raw"

# Server-encrypted
curl -L -O "{{BASE_URL}}/api/file/ab12cd34/raw?ek=<access_key>"
```

```python
import shutil, requests

with requests.get("{{BASE_URL}}/api/file/ab12cd34/raw", stream=True) as r:
    r.raise_for_status()
    with open("download.pdf", "wb") as f:
        shutil.copyfileobj(r.raw, f)
```

```javascript
import { createWriteStream } from "fs";
import fetch from "node-fetch";

const res = await fetch("{{BASE_URL}}/api/file/ab12cd34/raw");
const dest = createWriteStream("download.pdf");
await new Promise((resolve, reject) => {
  res.body.pipe(dest);
  res.body.on("error", reject);
  dest.on("finish", resolve);
});
```

### GET /api/file/{slug}/preview — Inline preview

Public. Serves the bytes for inline display — images, video, audio, PDFs and
text — with no `Content-Disposition: attachment`, and **without spending a use**
of the link.

That budget exemption is why a link with `max_uses` set exposes no preview at
all: it answers 403 regardless of key. Archived files are refused too, and so
are `client` and `sealed` ones, which the server has no key for.

Query parameters:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `ek` | string | no | Required for server-encrypted files, same secret `/raw` wants, same per-slug throttle when it is a password. |

Encrypted or compressed bytes are reproduced from byte zero, so those responses
are 200-only with no `Accept-Ranges` — seeking is unavailable. Untransformed
files support range requests as usual.

```bash
curl "{{BASE_URL}}/api/file/ab12cd34/preview"
curl "{{BASE_URL}}/api/file/ab12cd34/preview?ek=<access_key>"
```

## Folders

### GET /api/directories/ — List folders

Returns all folders you own or are a collaborator on.

```bash
curl "{{BASE_URL}}/api/directories/" \
  -H "Authorization: Bearer <your-api-key>"
```

```python
resp = requests.get(
    "{{BASE_URL}}/api/directories/",
    headers={"Authorization": "Bearer <your-api-key>"}
)
for d in resp.json()["directories"]:
    print(d["title"], d["file_count"])
```

```javascript
const res = await fetch("{{BASE_URL}}/api/directories/", {
  headers: { "Authorization": "Bearer <your-api-key>" }
});
const { directories } = await res.json();
console.log(directories);
```

Response (200 OK):

```json
{
  "directories": [
    {
      "id": 1,
      "title": "Project files",
      "slug": "xy99zz",
      "file_count": 4,
      "total_bytes": 819200,
      "encryption_mode": "none",
      "parent_directory_id": null,
      "subdirectory_count": 2,
      "encryption_overridden": true,
      "inherited_from_directory_id": null,
      "gallery_view": false,
      "role": "owner",
      "created_at": "2026-01-10T09:00:00Z"
    }
  ]
}
```

### POST /api/directories — Create a folder

Folders nest. A folder with no `parent_directory_id` sits at the root; anything
else is a child, at most 10 levels deep.

Body:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `title` | string | no | Defaults to `Untitled folder`. |
| `parent_directory_id` | integer | no | Containing folder. Omit for a root-level folder. |
| `encryption_mode` | `"none"` or `"server"` | no | Root-level folders only — a child always inherits its parent's, and passing this on a child is refused. |
| `password` | string | no | With `encryption_mode: "server"`: use this password as the `?ek=` secret instead of a random token. |
| `expires_in_seconds` | integer | no | Auto-expiry for the folder and its links. |

```bash
curl -X POST "{{BASE_URL}}/api/directories" \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"title": "Invoices", "parent_directory_id": 7}'
```

```python
resp = requests.post(
    "{{BASE_URL}}/api/directories",
    headers={"Authorization": "Bearer <your-api-key>"},
    json={"title": "Invoices", "parent_directory_id": 7}
)
print(resp.json()["url"])
```

```javascript
const res = await fetch("{{BASE_URL}}/api/directories", {
  method: "POST",
  headers: {
    "Authorization": "Bearer <your-api-key>",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({ title: "Invoices", parent_directory_id: 7 })
});
const folder = await res.json();
```

Response (200 OK):

```json
{
  "id": 12,
  "slug": "ab12cd",
  "url": "{{BASE_URL}}/d/ab12cd",
  "parent_directory_id": 7,
  "encryption_mode": "server",
  "encryption_overridden": false,
  "inherited_from_directory_id": 7,
  "password_locked": false,
  "key_check_blob": null,
  "access_key": "xJ3n…"
}
```

`encryption_overridden: false` means this folder holds no key of its own — it is
protected by whatever `inherited_from_directory_id` points at. See *Encryption
inheritance* below.

### GET /api/directories/{directory_id}/children — List one level

Returns the folders and files directly inside one folder, plus the breadcrumb
trail to it. Use the literal id `root` for the top level. This is deliberately
one level at a time; there is no recursive dump endpoint.

```bash
curl "{{BASE_URL}}/api/directories/root/children" \
  -H "Authorization: Bearer <your-api-key>"

curl "{{BASE_URL}}/api/directories/7/children" \
  -H "Authorization: Bearer <your-api-key>"
```

```python
resp = requests.get(
    "{{BASE_URL}}/api/directories/7/children",
    headers={"Authorization": "Bearer <your-api-key>"}
)
data = resp.json()
print([d["title"] for d in data["directories"]])
print([f["original_filename"] for f in data["files"]])
```

```javascript
const res = await fetch("{{BASE_URL}}/api/directories/7/children", {
  headers: { "Authorization": "Bearer <your-api-key>" }
});
const { directory, breadcrumbs, directories, files } = await res.json();
```

Response (200 OK):

```json
{
  "directory": { "id": 7, "title": "Projects", "...": "…" },
  "breadcrumbs": [{ "id": 3, "title": "Work" }, { "id": 7, "title": "Projects" }],
  "directories": [{ "id": 12, "title": "Invoices", "...": "…" }],
  "files": [{ "id": 1, "original_filename": "notes.txt", "...": "…" }]
}
```

`directory` and `breadcrumbs` are `null` and `[]` at the root.

### PATCH /api/directories/{directory_id} — Rename, or switch the public view

Body — send either or both:

| Name | Type | Description |
| --- | --- | --- |
| `title` | string | New folder name. |
| `gallery_view` | boolean | Render the folder's public page as a gallery of poster tiles with inline players, rather than a file list. Cosmetic only — it gates nothing. |

```bash
curl -X PATCH "{{BASE_URL}}/api/directories/7" \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"title": "Archive 2026", "gallery_view": true}'
```

The setting is read off the folder a link points at, so it stays put as a
visitor navigates deeper into the shared subtree.

### PATCH /api/directories/{directory_id}/move — Re-parent a folder

Body:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `parent_directory_id` | integer or null | yes | New parent, or `null` for the root. |

Refused if the target is the folder itself or one of its own descendants, or if
the move would push any part of the subtree past 10 levels. A moved folder keeps
the key its bytes are already under and becomes its own break point.

```bash
curl -X PATCH "{{BASE_URL}}/api/directories/12/move" \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"parent_directory_id": null}'
```

### POST /api/directories/{directory_id}/copy — Duplicate a folder

The recursive form of `POST /api/files/{file_id}/copy`: the folder, every folder
under it, and every file in all of them. No bytes are written — each file is a
reference count going up by one — but your logical quota is charged for the
whole subtree.

Requires `can_create_directories` **and** `can_upload`, plus edit rights on the
source folder and on the destination.

Body:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `parent_directory_id` | integer or null | no | New parent; omit or `null` for the root. |

Refused if the destination is the folder itself or one of its own descendants
(`400`), if the copy would push any part of the subtree past 10 levels (`400`),
or if the destination is `client`/`sealed` (`409`, same reason as the file
endpoint). If a folder of the same name is already there, the copy is named
`<title> - Copy`.

Encryption follows the same rule at every level: a node whose resolved key
matches its new parent's inherits, and one whose key differs becomes its own
break point. Each copied folder gets a fresh default share link, and each copied
file a fresh file link.

Returns the new folder, in the same shape as `GET /api/directories/`.

```bash
curl -X POST "{{BASE_URL}}/api/directories/12/copy" \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"parent_directory_id": null}'
```

### PATCH /api/directories/{directory_id}/encryption — Change a folder's encryption

Same shape as the file endpoint: `{"mode": "none"|"server"}` to give this folder
its own key, or `{"adopt_parent": true}` to follow its ancestors again. Optional
`password` with `mode: "server"`.

Every descendant whose bytes are currently protected by this folder's key is
re-encrypted in place; a subfolder holding its own key is left alone. That makes
this a slow request for a large subtree, and it runs synchronously.

```bash
curl -X PATCH "{{BASE_URL}}/api/directories/7/encryption" \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"mode": "server", "password": "correct horse battery"}'
```

Returns the updated folder plus `access_key`.

### PUT /api/directories/{directory_id}/access — Change the access secret

Identical to the file version: swaps the `?ek=` secret with no re-encryption.
Send `{"password": "…"}` for a chosen one, or an empty body for a fresh random
token. Only a folder that holds its own `server`-mode key has a secret to
change; an inheriting one is refused with 409 naming the folder that does.

```bash
curl -X PUT "{{BASE_URL}}/api/directories/7/access" \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### DELETE /api/directories/{directory_id} — Delete a folder

Deletes the folder, everything inside it, every subfolder beneath it, and all
their links. Refused if the subtree contains a folder owned by someone else.

```bash
curl -X DELETE "{{BASE_URL}}/api/directories/12" \
  -H "Authorization: Bearer <your-api-key>"
```

### GET /api/d/{slug}/info — Browse a shared folder

Public. Returns one level of a shared folder: its metadata, its subfolders, and
its files. Metadata is readable without a key, exactly as it always has been —
`?ek=` gates the *bytes*, on `/raw` and `/zip`.

Query parameters:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `dir` | integer | no | Walk into a descendant of the link's folder. Anything outside that subtree answers 404 — a link must not confirm what exists elsewhere. |

```bash
curl "{{BASE_URL}}/api/d/xy99zz/info"
curl "{{BASE_URL}}/api/d/xy99zz/info?dir=12"
```

Response (200 OK), abridged:

```json
{
  "id": 12,
  "entry_id": 7,
  "title": "Invoices",
  "breadcrumbs": [{ "id": 7, "title": "Projects" }, { "id": 12, "title": "Invoices" }],
  "encryption_mode": "server",
  "password_locked": false,
  "key_scope": "dir:7",
  "gallery_view": false,
  "directories": [{ "id": 15, "title": "2025", "key_scope": "dir:15", "...": "…" }],
  "files": [
    {
      "slug": "aa11bb",
      "filename": "march.pdf",
      "size_bytes": 20480,
      "content_type": "application/pdf",
      "encryption_mode": "server",
      "key_scope": "dir:7",
      "previewable": true
    }
  ],
  "file_count": 1,
  "total_bytes": 20480,
  "uploader": null,
  "already_saved": false
}
```

`key_scope` names *which* secret opens a node (`dir:7`, `file:34`). A shared
subtree can contain folders that broke away with keys of their own, so "the
folder's key" is no longer a single thing — hold a map keyed by scope.

`previewable` is the server's own answer to "would `GET /api/file/{slug}/preview`
serve these bytes?", which depends on storage transforms only it knows about.

### POST /api/d/{slug}/unlock — Check a key without downloading

Public. Proves a key or password for one node under a link, so a client can find
out whether it holds the right secret before offering to open something.

Body:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `ek` | string | yes | The key or password to check. |
| `dir` | integer | no | Which node under the link, same bounds as `/info`. |

```bash
curl -X POST "{{BASE_URL}}/api/d/xy99zz/unlock" \
  -H "Content-Type: application/json" \
  -d '{"ek": "correct horse battery", "dir": 12}'
```

Response (200 OK):

```json
{ "ok": true, "key_scope": "dir:12" }
```

A wrong secret answers 401. Password-locked nodes are rate-limited per slug and
answer 429 once the slug is locked out — see *Password locks* below.

### GET /api/d/{slug}/zip — Download folder as ZIP

Streams all files in a folder as a ZIP archive. Server-encrypted folders require
the access key. Note that a folder's public URL resolves via its
`directory_links` slug, not the directory's own slug.

Query parameters:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `ek` | string | no | Required for server-encrypted folders. |
| `dir` | integer | no | Zip a descendant of the link's folder instead, on that node's own key. |

The archive recurses, with folder structure preserved, but only as far as the
presented key reaches: plaintext descendants are included, and a subfolder that
broke away with a key of its own is skipped — bundling it would hand away the
whole point of a separate key. End-to-end and sealed members are skipped too,
since the server cannot decrypt them and shipping ciphertext under a plausible
filename is worse than shipping nothing.

```bash
curl -L -O "{{BASE_URL}}/api/d/xy99zz/zip"
```

```python
with requests.get("{{BASE_URL}}/api/d/xy99zz/zip", stream=True) as r:
    r.raise_for_status()
    with open("folder.zip", "wb") as f:
        for chunk in r.iter_content(chunk_size=8192):
            f.write(chunk)
```

```javascript
import { writeFileSync } from "fs";

const res = await fetch("{{BASE_URL}}/api/d/xy99zz/zip");
const buffer = await res.arrayBuffer();
writeFileSync("folder.zip", Buffer.from(buffer));
```

## Dropbox

### POST /api/dropbox/{slug} — Upload to a dropbox

Upload a file to a dropbox link without authentication. The link owner receives
it in their account. Supports the same form fields as the regular upload
endpoint.

Form fields:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `file` | file | yes | The file binary. |
| `original_filename` | string | yes | Filename to display to the owner. |
| `declared_size` | integer | no | Declared file size in bytes (used for the quota pre-check). |

```bash
curl -X POST "{{BASE_URL}}/api/dropbox/<dropbox-slug>" \
  -F "file=@./document.pdf" \
  -F "original_filename=document.pdf"
```

```python
with open("document.pdf", "rb") as f:
    resp = requests.post(
        "{{BASE_URL}}/api/dropbox/<dropbox-slug>",
        files={"file": f},
        data={"original_filename": "document.pdf"},
    )
print(resp.json())
```

```javascript
const form = new FormData();
form.append("file", createReadStream("document.pdf"));
form.append("original_filename", "document.pdf");

await fetch("{{BASE_URL}}/api/dropbox/<dropbox-slug>", {
  method: "POST",
  body: form,
});
```

Response (200 OK):

```json
{ "status": "received", "file_id": 42 }
```

## Account

### GET /api/account/me — Get current user

Returns the authenticated user's profile, permissions, and quota.

```bash
curl "{{BASE_URL}}/api/account/me" \
  -H "Authorization: Bearer <your-api-key>"
```

```python
resp = requests.get(
    "{{BASE_URL}}/api/account/me",
    headers={"Authorization": "Bearer <your-api-key>"}
)
me = resp.json()
print(me["username"], me["used_bytes"], "/", me["quota_bytes"])
```

```javascript
const res = await fetch("{{BASE_URL}}/api/account/me", {
  headers: { "Authorization": "Bearer <your-api-key>" }
});
console.log(await res.json());
```

Response (200 OK):

```json
{
  "id": 5,
  "username": "alice",
  "role": "user",
  "email": "alice@example.com",
  "has_avatar": false,
  "used_bytes": 204800,
  "quota_bytes": 5368709120,
  "can_upload": true,
  "can_upload_client_encrypted": true,
  "can_delete": true,
  "can_use_api_keys": true,
  "can_regenerate_links": true,
  "can_delete_links": true,
  "can_create_directories": true,
  "can_manage_lifecycle": false,
  "can_use_torrents": false,
  "can_watch_media": true,
  "require_mfa": false,
  "require_passkey": false
}
```

## Media library

A folder published as a **library collection** shows up on the `/watch` page and
its video/audio files become playable titles. A collection is either `public`
(anyone, no account) or `restricted` (an account holding `can_watch_media` — the
owner and masters always qualify).

External players don't carry a session cookie, so restricted titles are also
reachable with a **play key**: a signed, expiring, revocable token you append to
the stream URL as `?k=`. That is the mpv path.

### GET /api/media/library — Browse the library

Session-authenticated or anonymous. Anonymous callers see only public
collections; a signed-in caller additionally sees the restricted ones they're
entitled to.

```bash
curl "{{BASE_URL}}/api/media/library"
```

Response (200 OK):

```json
{
  "collections": [
    {
      "slug": "P7A0vMFIe4Qarqe2t4dLsw",
      "directory_id": 1,
      "title": "Test Season 1",
      "overview": "A test season.",
      "kind": "series",
      "visibility": "restricted",
      "entry_count": 2,
      "total_duration_seconds": 7,
      "published_at": "2026-07-30T19:24:40.742Z",
      "uploader": { "username": "tester" },
      "has_poster": true,
      "can_curate": true
    }
  ],
  "viewer": { "username": "tester", "can_watch_media": true }
}
```

### GET /api/media/library/{slug} — Collection detail

Same payload plus an `entries` array. A restricted collection you aren't
entitled to answers `404`, not `403`, so titles can't be discovered by guessing
slugs.

```json
{
  "entries": [
    {
      "file_id": 1,
      "title": "ep1.mp4",
      "content_type": "video/mp4",
      "size_bytes": 18424,
      "kind": "video",
      "duration_seconds": 4,
      "width": 320,
      "height": 240,
      "client_encrypted": false,
      "seekable": true,
      "archived": false
    }
  ]
}
```

`seekable` is `false` for titles stored encrypted, compressed or archived at
rest: those are reproduced from byte zero, so the stream answers `200` without
`Accept-Ranges` and the player cannot seek. `client_encrypted` titles can only
be played in the browser that holds the key — never by an external player.

### PUT /api/media/library/{directory_id} — Publish a folder

Session + CSRF, owner or master. Publishing probes each title for runtime and
resolution, so the first call on a large folder takes a moment.

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `visibility` | string | no | `public` or `restricted` (default). |
| `kind` | string | no | `series` (episode list) or `movie` (single title). |
| `overview` | string | no | Description, max 2000 chars. `null` clears it. |
| `poster_file_id` | integer | no | A file in this folder to use as cover art. |

```bash
curl -X PUT "{{BASE_URL}}/api/media/library/1" \
  -H "X-CSRF-Token: $CSRF" -H "Content-Type: application/json" \
  -d '{"visibility":"restricted","kind":"series","overview":"A test season."}'
```

`DELETE /api/media/library/{directory_id}` unpublishes it. Outstanding play keys
stop working immediately — nothing outside a published folder is streamable.

### POST /api/media/playkeys — Mint a play key

Session + CSRF. Pass exactly one of `file_id` (plays that one title) or
`directory_id` (plays every title in the collection, via the m3u playlist).

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `file_id` | integer | one of | Title to scope the key to. |
| `directory_id` | integer | one of | Collection to scope the key to. |
| `ttl_seconds` | integer | no | Lifetime, clamped to 60s–30d. Default 12h. |
| `label` | string | no | Shown in your key list. |
| `bind_ip` | boolean | no | Pin the key to the requesting address. |

```bash
curl -X POST "{{BASE_URL}}/api/media/playkeys" \
  -H "X-CSRF-Token: $CSRF" -H "Content-Type: application/json" \
  -d '{"file_id":1,"ttl_seconds":3600,"label":"laptop mpv"}'
```

Response (201 Created) — `key` and `url` are shown **once**:

```json
{
  "id": 1,
  "scope": "file",
  "file_id": 1,
  "directory_id": null,
  "label": "laptop mpv",
  "bound_ip": null,
  "expires_at": "2026-07-30T20:24:52.483Z",
  "key": "ZmSI21zVks9PKV8SW2xtMOEJ...",
  "url": "{{BASE_URL}}/api/media/stream/1?k=ZmSI21zVks9PKV8SW2xtMOEJ...",
  "mpv_command": "mpv \"{{BASE_URL}}/api/media/stream/1?k=ZmSI21zVks9PKV8SW2xtMOEJ...\""
}
```

`GET /api/media/playkeys` lists your live keys (never the tokens themselves);
`DELETE /api/media/playkeys/{id}` revokes one, killing it mid-playback. A key
also stops working the moment its owner loses `can_watch_media`, and it is only
valid against the node that minted it.

### GET /api/media/stream/{file_id} — Play a title

The playback endpoint. Authenticate with `?k=<play key>` or a session cookie;
public collections need neither. Honours `Range` for seekable titles.

```bash
mpv "{{BASE_URL}}/api/media/stream/1?k=<play-key>"
```

```bash
# The whole collection, in order, as a playlist
mpv "{{BASE_URL}}/api/media/library/<slug>/playlist.m3u?k=<collection-play-key>"
```

```python
with requests.get(
    "{{BASE_URL}}/api/media/stream/1",
    params={"k": PLAY_KEY},
    stream=True,
) as r:
    r.raise_for_status()
    with open("ep1.mp4", "wb") as f:
        for chunk in r.iter_content(chunk_size=8192):
            f.write(chunk)
```

`GET /api/media/library/{slug}/poster` and
`GET /api/media/entry/{file_id}/thumbnail` return cached JPEG artwork under the
same access rules.

## Realtime

Every action on the server (uploads, deletes, logins, link changes, admin
actions — anything that writes to the audit log) is published as an **event** in
real time. Subscribe over WebSocket for a live stream of your own events.
Cluster-wide streaming and node linking live on the **Cluster** page.

**Event payload.** Each frame is JSON. Stream frames carry a `type` of `ready`
(sent once on connect) or `event`.

```json
{
  "type": "event",
  "id": 1421,
  "ts": "2026-06-29T12:00:00+00:00",
  "action": "file.uploaded",
  "actor": "alice",
  "target": "file:42",
  "ip": "203.0.113.7"
}
```

`id` is a monotonic per-process sequence — use it as a cursor. `actor` is a
username, or `system` / `dropbox` / `apikey:<id>`.

**Reconnect without gaps.** The server retains a buffer of recent events. Pass
the highest `id` you have already processed as `?after=` (WebSocket or poll) to
replay only what you missed.

### GET /api/ws/events — Per-user event stream (WebSocket)

Authenticated by your session cookie — open it from the browser app. A regular
user receives only their own events (across every session and node); a master
receives the full firehose. Closes with code `4401` if the session cookie is
missing or invalid.

Query parameters:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `after` | integer | no | Replay buffered events with a higher id before streaming live ones. |

```bash
# WebSockets aren't curl-friendly; use websocat with your session cookie:
websocat "{{WS_BASE_URL}}/api/ws/events" \
  -H "Cookie: fu_session=<your-session-cookie>"
```

```python
import json, websockets, asyncio

async def main():
    url = "{{WS_BASE_URL}}/api/ws/events"
    async with websockets.connect(url, additional_headers={"Cookie": "fu_session=<cookie>"}) as ws:
        async for raw in ws:
            evt = json.loads(raw)
            if evt["type"] == "event":
                print(evt["action"], evt["actor"])

asyncio.run(main())
```

```javascript
const ws = new WebSocket("{{WS_BASE_URL}}/api/ws/events");
ws.onmessage = (m) => {
  const evt = JSON.parse(m.data);
  if (evt.type === "event") console.log(evt.action, evt.actor);
};
```

The cluster-wide event firehose, HTTP poll, and the tooling to reveal/rotate
this server's cluster token and link other nodes live on the dedicated
**Cluster** page, which requires the `can_manage_cluster` permission.

## Encryption modes

Files support four encryption modes. Choose based on your security
requirements.

### `none` — No encryption

The link slug is the only credential. Anyone with the link can download the
file. Fast and simple for non-sensitive content.

```
{{BASE_URL}}/api/file/<slug>/raw
```

### `server` — Server-side encryption

The server encrypts the file at rest. An access key (`?ek=...`) is required to
download. The server holds the key — use this when you need convenient sharing
but don't require end-to-end security.

```
{{BASE_URL}}/api/file/<slug>/raw?ek=<access_key>
```

### `client` — End-to-end (client-side) encryption

The file is encrypted in the browser before upload. The server never sees the
plaintext. The `#ek=` fragment is never sent to the server. Ideal for maximum
privacy — but the server cannot decrypt even if compelled.

```
{{BASE_URL}}/api/file/<slug>#ek=<client_key>
```

### `sealed` — Seal & forget

Server-side encryption whose key the server generated, handed back once, and
then threw away (`POST /api/files/{file_id}/seal`). Every read path treats it
exactly like `client`: the server cannot decrypt it, and the key travels in the
fragment. The difference from true end-to-end is honest and narrow — the key
existed in server memory for the duration of the sealing request.

```
{{BASE_URL}}/api/file/<slug>#ek=<sealed_key>
```

### Encryption inheritance

A folder or file with `encryption_overridden: false` holds no key of its own.
Its *effective* encryption is whatever the nearest ancestor with
`encryption_overridden: true` has, and `inherited_from_directory_id` names that
ancestor. A root-level folder is always its own break point — there is nothing
above it to inherit from.

That is what makes the following work: encrypt a folder, share its link, and
everything under it opens with that one key. Give a subfolder its own key with
`PATCH /api/directories/{id}/encryption` and it breaks away — the parent's link
still lists it, but the parent's key no longer opens it. Set a subfolder to
`none` and it is plaintext inside an otherwise encrypted tree.

A file uploaded into a folder takes that folder's effective encryption; the
`encryption_mode` you pass at upload time only decides anything for a root-level
upload. A folder that is end-to-end encrypted can only be uploaded into by a
client that holds its key — the server refuses to file plaintext under a mode
that promises ciphertext, so dropbox links, remote uploads and torrent imports
into such a folder are rejected with 409.

Every public endpoint reports a `key_scope` (`dir:7`, `file:34`) naming which
secret opens that node, because one shared subtree can need several.

### Password locks

The `?ek=` secret of a `server`-mode file or folder is a 144-bit random token by
default. `PUT /api/files/{id}/access` and `PUT /api/directories/{id}/access` let
you replace it with a chosen password, and `password_locked: true` on the public
metadata says so.

Because a human password *is* guessable over the network, every public check of
a password-locked secret is rate-limited **per link slug** — not per IP, which a
distributed guesser would sail straight past. After a handful of wrong guesses
the slug answers 429 for a while, including to the correct password. A missing
`?ek=` counts as a failed attempt, so the counter cannot be dodged by omitting
the parameter. Random-token links are deliberately not throttled: 144 bits is
not a guessing target, and throttling them would let anyone lock a public link
out of service.

### Converting to and from end-to-end encryption

There is no server-side conversion into `client` mode, because by definition the
server must never see the key. The sequence is:

1. `GET /api/files/{id}/content` — your own bytes, no share-link use spent.
2. Decrypt and/or re-encrypt locally.
3. Upload the result as a new file.
4. `POST /api/files/{id}/e2e-conversion` on the **new** file, naming the old one
   as `replaced_file_id`. The old file and its links are deleted and the
   transition is written to the audit log.

`POST /api/files/{id}/seal` is the one-way server-side variant: it needs no
re-upload, at the cost of the key existing in server memory once.

## Errors

All error responses use JSON with a `detail` field:

```json
{ "detail": "not found" }
```

| Status | Meaning | Common cause |
| --- | --- | --- |
| 400 | Bad request | Invalid body, missing required field, or value out of range. |
| 401 | Unauthorized | Missing or invalid API key / session. Check your `Authorization` header. |
| 403 | Forbidden | Your account lacks the required permission, or you don't own the resource. |
| 404 | Not found | Unknown slug, expired link, exhausted download count, or deleted file. |
| 409 | Conflict | Duplicate save — you already saved this file, or you own it. |
| 413 | Payload too large | File exceeds your remaining quota or the per-file size cap. |
| 422 | Unprocessable | Request validation failed — check field types and constraints. |
| 429 | Too many requests | Rate limit hit. Back off and retry after a short delay. |
| 500 | Server error | Unexpected internal error. Contact the admin. |
