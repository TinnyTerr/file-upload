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
      "role": "owner",
      "created_at": "2026-01-10T09:00:00Z"
    }
  ]
}
```

### GET /api/d/{slug}/zip — Download folder as ZIP

Streams all files in a folder as a ZIP archive. Server-encrypted folders require
the access key. Note that a folder's public URL resolves via its
`directory_links` slug, not the directory's own slug.

Query parameters:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `ek` | string | no | Required for server-encrypted folders. |

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
  "can_delete": true,
  "can_use_api_keys": true,
  "can_regenerate_links": true,
  "can_delete_links": true,
  "can_use_dropbox": false
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

Files support three encryption modes. Choose based on your security
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
