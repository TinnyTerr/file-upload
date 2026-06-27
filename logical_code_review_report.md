# Logical Code Review Report

This report presents the findings of a comprehensive code review focusing strictly on **logical bugs** (excluding security vulnerabilities) across the application codebase. 

A total of **26 logical bugs** were identified by 7 concurrent subagents (5 backend-focused, 2 frontend-focused). They are grouped below by component/layer.

---

## 1. File Transfer & Upload Routes (`app/routes/files.py`)

### 1.1 Temporary File Leak on Non-HTTPException in Single-Shot Uploads
* **File Path**: [files.py](file:///c:/Users/fagol/Documents/fuck/fileupload/app/routes/files.py#L317-L330)
* **Description**: During single-shot file uploads, if any unexpected exception other than `HTTPException` (e.g., connection reset, network failure, or I/O error) occurs while reading the request body or writing to the file handle, the temporary `.work` file is leaked on the disk.
* **Root Cause**: The error-handling cleanup block specifically catches `HTTPException`. Other exception types bypass this block and do not delete the `.work` file.
* **Suggested Fix**:
  ```diff
  @@ -325,6 +325,6 @@
                   if stored > perm.max_file_bytes:
                       raise HTTPException(413, detail="file exceeds max file size")
                   fh.write(chunk)
  -    except HTTPException:
  +    except Exception:
           work.unlink(missing_ok=True)
           raise
  ```

---

### 1.2 Orphaned Files on Database Commit Failure
* **File Path**: [files.py](file:///c:/Users/fagol/Documents/fuck/fileupload/app/routes/files.py#L239-L262)
* **Description**: If the database transaction commit (`db.commit()`) or any other DB operation inside `_finalize_stored_file` (e.g., Link creation) fails, the transaction is rolled back, but the uploaded file has already been renamed to `base_path` and is leaked permanently on the disk.
* **Root Cause**: The link creation and database commit operations are performed outside the main `try-except` block of `_finalize_stored_file`. Database errors bypass the file cleanup handler.
* **Suggested Fix**:
  ```diff
  @@ -236,25 +236,25 @@
           file_obj.stored_size_bytes = base_path.stat().st_size
           file_obj.enc_key_blob = enc_key_blob_val
           file_obj.enc_access_blob = enc_access_blob_val
  -
  -    except Exception:
  -        for p in [work_path, base_path.with_suffix(".zst.work"), base_path.with_suffix(".fupl.work"), base_path]:
  -            p.unlink(missing_ok=True)
  -        db.rollback()
  -        raise
  -
  -    expires_link: datetime | None = None
  -    link_max_uses = max_uses
  -    if directory is not None:
  -        # Bundle members are reached through the directory page, not a capped
  -        # per-file link, so they get an uncapped link and the directory tally grows.
  -        link_max_uses = None
  -        directory.total_bytes = (directory.total_bytes or 0) + file_obj.stored_size_bytes
  -    elif expires_in_seconds is not None:
  -        expires_link = datetime.now(timezone.utc) + timedelta(seconds=expires_in_seconds)
  -
  -    slug = new_slug()
  -    link = Link(file_id=file_obj.id, slug=slug, max_uses=link_max_uses, expires_at=expires_link)
  -    db.add(link)
  -
  -    record(db, actor=user.username, action="file.uploaded",
  -           target=f"file:{file_obj.id}", ip=client_ip(request))
  -    db.commit()
  +        
  +        expires_link: datetime | None = None
  +        link_max_uses = max_uses
  +        if directory is not None:
  +            # Bundle members are reached through the directory page, not a capped
  +            # per-file link, so they get an uncapped link and the directory tally grows.
  +            link_max_uses = None
  +            directory.total_bytes = (directory.total_bytes or 0) + file_obj.stored_size_bytes
  +        elif expires_in_seconds is not None:
  +            expires_link = datetime.now(timezone.utc) + timedelta(seconds=expires_in_seconds)
  +
  +        slug = new_slug()
  +        link = Link(file_id=file_obj.id, slug=slug, max_uses=link_max_uses, expires_at=expires_link)
  +        db.add(link)
  +
  +        record(db, actor=user.username, action="file.uploaded",
  +               target=f"file:{file_obj.id}", ip=client_ip(request))
  +        db.commit()
  +    except Exception:
  +        for p in [work_path, base_path.with_suffix(".zst.work"), base_path.with_suffix(".fupl.work"), base_path]:
  +            p.unlink(missing_ok=True)
  +        db.rollback()
  +        raise
  ```

---

### 1.3 File Deleted from Disk Prior to Database Commit
* **File Path**: [files.py](file:///c:/Users/fagol/Documents/fuck/fileupload/app/routes/files.py#L786-L802)
* **Description**: In the `delete_file` endpoint, the physical file is unlinked on disk before the database transaction commits. If the database delete or audit record commit subsequently fails, the database transaction rolls back, leaving the file registered in the DB even though the actual file has been deleted.
* **Root Cause**: Unlinking is performed before the database transaction changes are finalized/committed.
* **Suggested Fix**:
  ```diff
  @@ -783,19 +783,19 @@
       if user.role != "master" and file_obj.owner_id != user.id:
           raise HTTPException(403, detail="not your file")
   
  -    try:
  -        full_path = safe_join(storage_root(), file_obj.storage_path)
  -        if full_path.exists():
  -            os.unlink(full_path)
  -    except OSError:
  -        pass
  -
       db.query(Link).filter_by(file_id=file_obj.id).delete()
       if file_obj.directory_id is not None:
           from app.models.directory import Directory
           directory = db.get(Directory, file_obj.directory_id)
           if directory is not None:
               directory.total_bytes = max(0, (directory.total_bytes or 0) - (file_obj.stored_size_bytes or 0))
  +            
  +    full_path = safe_join(storage_root(), file_obj.storage_path)
       db.delete(file_obj)
       record(db, actor=user.username, action="file.deleted",
              target=f"file:{file_id}", ip=client_ip(request))
       db.commit()
  +    try:
  +        if full_path.exists():
  +            os.unlink(full_path)
  +    except OSError:
  +        pass
  ```

---

### 1.4 Stale Temporary `.work` Files are Never Swept
* **File Path**: [files.py](file:///c:/Users/fagol/Documents/fuck/fileupload/app/routes/files.py#L440-L460)
* **Description**: Unfinished single-shot uploads leave stale `.work` files in storage. However, the background directory sweeper only cleans up `.parts` directories and `.part` files.
* **Root Cause**: The background cleanup job logic (`_sweep_stale_parts`) is missing the pattern matching to locate and delete `*.work` files.
* **Suggested Fix**:
  ```diff
  @@ -454,6 +454,12 @@
                   if p.is_file() and p.stat().st_mtime < cutoff:
                       p.unlink(missing_ok=True)
               except OSError:
                   pass
  +        for p in root.rglob("*.work"):
  +            try:
  +                if p.is_file() and p.stat().st_mtime < cutoff:
  +                    p.unlink(missing_ok=True)
  +            except OSError:
  +                pass
       except OSError:
           pass
  ```

---

## 2. Directories & Public Routes (`app/routes/directories.py`, `app/routes/public.py`)

### 2.1 Duplicate Naming Collision Bug in ZIP Archiving
* **File Path**: [directories.py](file:///c:/Users/fagol/Documents/fuck/fileupload/app/routes/directories.py#L414-L424)
* **Description**: The folder ZIP generation endpoint's deduplication logic fails if a directory contains a file that matches a dynamically generated filename (e.g. `file (1).txt` already exists, and a duplicate `file.txt` is added).
* **Root Cause**: The `seen` dictionary only tracks name counters for original clean filenames but does not check or register generated target names in the set.
* **Suggested Fix**:
  ```diff
  -def _safe_arcname(name: str, seen: dict[str, int]) -> str:
  -    """Flatten to a safe in-zip name and de-duplicate collisions."""
  -    base = os.path.basename(name.replace("\\", "/")).strip() or "file"
  -    base = "".join(c for c in base if ord(c) >= 0x20)
  -    if base in seen:
  -        seen[base] += 1
  -        stem, dot, ext = base.partition(".")
  -        base = f"{stem} ({seen[base]}){dot}{ext}" if dot else f"{base} ({seen[base]})"
  -    else:
  -        seen[base] = 0
  -    return base
  +def _safe_arcname(name: str, seen: set[str]) -> str:
  +    """Flatten to a safe in-zip name and de-duplicate collisions."""
  +    base = os.path.basename(name.replace("\\", "/")).strip() or "file"
  +    base = "".join(c for c in base if ord(c) >= 0x20)
  +    stem, dot, ext = base.partition(".")
  +    candidate = base
  +    counter = 1
  +    while candidate in seen:
  +        candidate = f"{stem} ({counter}){dot}{ext}" if dot else f"{base} ({counter})"
  +        counter += 1
  +    seen.add(candidate)
  +    return candidate
  ```
  *(Also update `seen = {}` to `seen = set()` in the caller).*

---

### 2.2 ZIP Download Fails/Corrupts Archived Files due to Missing Decompression
* **File Path**: [directories.py](file:///c:/Users/fagol/Documents/fuck/fileupload/app/routes/directories.py#L354-L367)
* **Description**: Downloading a folder ZIP fails or populates the archive with compressed junk data if any of the files in the folder have been processed/compressed by the background lifecycle compression job.
* **Root Cause**: The member-reading utility `_member_plaintext` reads bytes directly from disk or decrypts them without checking if the file is stored in compressed format (`f.compressed` or `f.archived` is `True`).
* **Suggested Fix**: Check if the file is compressed, run decompression via `decompress_stream` from `app.storage.compress`, and then apply decryption if the file is server-encrypted.

---

### 2.3 Incorrect Order of Decryption & Decompression in Single File Downloads
* **File Path**: [public.py](file:///c:/Users/fagol/Documents/fuck/fileupload/app/routes/public.py#L177-L204)
* **Description**: Raw download (`/file/{slug}/raw`) of an archived, server-encrypted file always fails with `500 decryption failed`.
* **Root Cause**: The code attempts to decrypt first and then decompress. However, when archived, the file is stored as compressed ciphertext. Decryption fails because the file on disk has zstd headers instead of the file encryption magic headers (`FUPL`). Decompression must happen first to retrieve the ciphertext, which is then decrypted.
* **Suggested Fix**: Decompress first using `decompress_stream` into a temporary file, then run `decrypt_stream` on that temporary file.

---

### 2.4 Range Request Spec Violation on Out-of-Bounds End Byte
* **File Path**: [public.py](file:///c:/Users/fagol/Documents/fuck/fileupload/app/routes/public.py#L78-L94)
* **Description**: HTTP Range requests with an end byte index greater than or equal to the file size (e.g. `bytes=0-2000` on a 500-byte file) fail with a `416 Range Not Satisfiable` status code.
* **Root Cause**: The range parser checks `end >= file_size` and rejects the request. However, RFC 7233 dictates that the parser should cap the requested end range to `file_size - 1`.
* **Suggested Fix**:
  ```diff
       if s:
           start = int(s)
           end = int(e) if e else file_size - 1
  +        if end >= file_size:
  +            end = file_size - 1
       elif e:
           suffix = int(e)
           start = max(0, file_size - suffix)
           end = file_size - 1
       else:
           return None
  -    if start > end or start >= file_size or end >= file_size:
  +    if start > end or start >= file_size:
           return None
  ```

---

### 2.5 Unhandled OverflowError in Directory Expiry Calculation
* **File Path**: [directories.py](file:///c:/Users/fagol/Documents/fuck/fileupload/app/routes/directories.py#L117-L118)
* **Description**: If a user creates a directory and sets a very large integer for `expires_in_seconds`, the application crashes with a `500 Internal Server Error`.
* **Root Cause**: Adding a massive number of seconds to `datetime.now()` raises a Python `OverflowError` in `timedelta`.
* **Suggested Fix**: Wrap the addition in a `try...except OverflowError` block and return an appropriate `400 Bad Request` HTTP status.

---

## 3. Database Layer & User Management (`app/db.py`, `app/routes/users.py`)

### 3.1 Unresolved Foreign Key Dependencies on User Deletion
* **File Path**: [users.py](file:///c:/Users/fagol/Documents/fuck/fileupload/app/routes/users.py#L104-L124)
* **Description**: Attempting to delete a user who has active API keys, credentials, directories, or uploaded files crashes the endpoint with an `IntegrityError`.
* **Root Cause**: SQLite foreign key constraints are enforced on connections. None of the dependent tables configure cascade deletes. Since `delete_user` only removes `SessionRow` and `Permission` rows, the operation fails the integrity checks.
* **Suggested Fix**: Modify the `delete_user` endpoint to delete dependent `ApiKey`, `Credential`, `Directory`, and `FileObject` records (and clean up their physical files) before deleting the user.

---

### 3.2 Silent Transaction Failure and Download Limit Bypass
* **File Path**: [public.py](file:///c:/Users/fagol/Documents/fuck/fileupload/app/routes/public.py#L135-L144)
* **Description**: Users can bypass the max download limit of shared links.
* **Root Cause**: In `/file/{slug}/raw`, the database commit that increments the download usage count is wrapped in a `try...except` block that silently handles exceptions with `pass`. If the database commit fails, the transaction rolls back, resetting the usage count increment, but the file download response still proceeds.
* **Suggested Fix**: Call `db.rollback()` and raise a `500 Internal Server Error` exception if the transaction commit fails.

---

### 3.3 Potential SQLite Deadlocks during Migrations
* **File Path**: [db.py](file:///c:/Users/fagol/Documents/fuck/fileupload/app/db.py#L95-L104)
* **Description**: Database initialization/migrations can result in SQLite locking issues or deadlocks.
* **Root Cause**: Inside `_migrate_add_columns`, the migration logic opens a write transaction using `engine.begin()` but uses a separate connection by calling `inspect(engine)` to query table columns. This is prone to locking conflicts in SQLite's single-writer architecture.
* **Suggested Fix**: Use `inspect(conn)` on the active transaction connection instead of `inspect(engine)` to reuse the connection.

---

## 4. Compression & Lifecycle Cleanup Jobs (`app/storage/`, `app/jobs/lifecycle.py`)

### 4.1 Resource Leak: Unclosed Zstd Decompressor Context
* **File Path**: [compress.py](file:///c:/Users/fagol/Documents/fuck/fileupload/app/storage/compress.py#L40-L50)
* **Description**: Memory resources leak on every file decompression.
* **Root Cause**: The stream reader returned by `zstd.ZstdDecompressor.stream_reader` is never closed. It allocates C-level zstandard decompression contexts which leak until the reader is garbage-collected.
* **Suggested Fix**: Use the reader in a `with dctx.stream_reader(...) as reader` block to guarantee it is closed.

---

### 4.2 Orphaned File Storage Leak on Windows (Silent Deletion Failures)
* **File Path**: [lifecycle.py](file:///c:/Users/fagol/Documents/fuck/fileupload/app/jobs/lifecycle.py#L105-L110)
* **Description**: If a file scheduled for background deletion is open (locked) on a Windows host, the physical file is not deleted, but the database records are still removed. The file is permanently leaked.
* **Root Cause**: The `_delete_file` helper function catches deletion failures with `except OSError: pass` and proceeds to delete DB records anyway.
* **Suggested Fix**: If `path.unlink()` raises an `OSError` (and the file is not already missing), log the error and return early from `_delete_file` without deleting the database records so the job will retry it.

---

### 4.3 Logical State Bug: Compressed Files Stalled in Active State Forever
* **File Path**: [lifecycle.py](file:///c:/Users/fagol/Documents/fuck/fileupload/app/jobs/lifecycle.py#L35-L36)
* **Description**: Files uploaded with pre-compression (`f.compressed == True`) are never transitioned to the `"archived"` state.
* **Root Cause**: The archive background job `archive_idle_job` encounters `if f.compressed:` and performs a `continue`. It leaves the file's lifecycle state as `"active"` and `archived == False` forever, meaning the database queries will check these files repeatedly on every run.
* **Suggested Fix**: For pre-compressed files, update their state flags (`f.archived = True`, `f.lifecycle_state = "archived"`) and commit the transaction.

---

### 4.4 Failure to Handle Missing Files in Archive Job (Perpetual Processing)
* **File Path**: [lifecycle.py](file:///c:/Users/fagol/Documents/fuck/fileupload/app/jobs/lifecycle.py#L40-L41)
* **Description**: If a file record exists in the DB but the file is missing from storage, the archiver is stuck in a loop on future runs.
* **Root Cause**: When the file does not exist, `archive_idle_job` hits `if not src.exists(): continue` silently, leaving the file in the `"active"` state.
* **Suggested Fix**: If the file is missing, log a warning and run `_delete_file` to remove the stale database records.

---

## 5. Share Links, Policies & Cryptography (`app/links/`, `app/permissions/`, `app/security/`, `app/crypto/`)

### 5.1 Link Sharing Consumption Bypass (Information Leak)
* **File Path**: [consume.py](file:///c:/Users/fagol/Documents/fuck/fileupload/app/links/consume.py#L15-L22)
* **Description**: Share links that have exceeded their maximum usage limit (`max_uses`) are still resolved as valid, leaking metadata.
* **Root Cause**: `resolve_active_link` validates if the link is active and not expired, but completely fails to check if `use_count >= max_uses`.
* **Suggested Fix**:
  ```diff
  def resolve_active_link(session: Session, slug: str, now: datetime | None = None) -> Link | None:
      now = _now(now)
      link = session.query(Link).filter_by(slug=slug).one_or_none()
      if link is None or not link.active:
          return None
      if link.expires_at is not None and link.expires_at <= now:
          return None
+     if link.max_uses is not None and link.use_count >= link.max_uses:
+         return None
      return link
  ```

---

### 5.2 Master Permissions Enforcement Bug
* **File Path**: [policy.py](file:///c:/Users/fagol/Documents/fuck/fileupload/app/permissions/policy.py#L21-L31)
* **Description**: If a user is promoted to master or has their master status asserted on runtime bootstrap, their permissions are not elevated.
* **Root Cause**: `ensure_permissions` returns the existing permission row immediately if it exists, without setting all flags to `True` when `master=True` is requested.
* **Suggested Fix**: Update the code to flush the database and set all flags to `True` for the existing record when `master=True`.

---

### 5.3 Lockout Policy Attempts Tracking Bug (No Time-based Decay)
* **File Path**: [lockout.py](file:///c:/Users/fagol/Documents/fuck/fileupload/app/security/lockout.py#L37-L56)
* **Description**: Login failure counters do not decay, leading to immediate lockouts long after the initial failed attempts occurred.
* **Root Cause**: `register_failure` increments `failed_count` but never resets it if the elapsed time since the last failure is outside the lockout window.
* **Suggested Fix**: Check if `_utcnow() - row.updated_at > lockout_seconds` and reset `failed_count = 0` prior to incrementing.

---

### 5.4 Decryption Stream Truncation Bypass & Empty File Verification Bugs
* **File Path**: [aead.py](file:///c:/Users/fagol/Documents/fuck/fileupload/app/crypto/aead.py#L49-L67)
* **Description**: Truncation in intermediate file chunks goes undetected, and corrupted files indicating 0 chunks are decrypted as valid.
* **Root Cause**: 
  1. `decrypt_stream` checks `len(ct) < 16` for intermediate chunks. If a chunk is truncated (e.g. 100 bytes instead of the expected `_PLAINTEXT_CHUNK + 16` bytes), it is not caught by the check, resulting in a generic cryptographic validation exception instead of a clear truncation error.
  2. If the file header sets `total = 0` (which is invalid as a valid file always has at least 1 chunk), the stream decrypts successfully and yields nothing.
* **Suggested Fix**: Ensure intermediate chunks check if `len(ct) < expected_len` and raise a `ValueError` for truncation. Also assert that `total > 0`.

---

## 6. Frontend UI Core & File Operations (`app/static/js/files.js`, `app/static/js/download.js`)

### 6.1 UI State Corruption on Dismissed Failed Uploads
* **File Path**: [files.js](file:///c:/Users/fagol/Documents/fuck/fileupload/app/static/js/files.js#L852)
* **Description**: Dismissed files magically reappear in the upload queue UI list.
* **Root Cause**: When a chunked upload fails and the user clicks the "✕" (Dismiss) button, the element is removed from the DOM and state array. However, pending chunk upload requests are not aborted. When any pending request finishes successfully, it triggers `bumpProgress() -> refreshQueueItem()`. Since the DOM element is missing, `refreshQueueItem` falls back to building and appending a new DOM element, causing it to reappear.
* **Suggested Fix**: Add a check in `refreshQueueItem` to return early if the item is no longer present in the `fileQueue` array:
  ```diff
  function refreshQueueItem(item) {
  +   if (!fileQueue.some(i => i.id === item.id)) return;
      const el = document.getElementById(`fq-${item.id}`);
      const newEl = buildQueueItem(item);
  ```

---

### 6.2 Firefox Dynamic Anchor Download Failure
* **File Path**: [download.js](file:///c:/Users/fagol/Documents/fuck/fileupload/app/static/js/download.js#L75-L80)
* **Description**: Client-side decryption downloads fail completely in Firefox.
* **Root Cause**: In `clientDecryptAndDownload`, the download triggers by calling `a.click()` on a dynamically created anchor element. Firefox rejects click events on anchors that are not appended to the active DOM body tree.
* **Suggested Fix**: Append the anchor element to the document body temporarily, trigger the click, and remove it immediately:
  ```diff
      const blob = new Blob([plaintext]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
  +   document.body.appendChild(a);
      a.click();
  +   a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
  ```

---

### 6.3 Indefinite Queue Hang on Decryption Worker Startup / Runtime Error
* **File Path**: [files.js](file:///c:/Users/fagol/Documents/fuck/fileupload/app/static/js/files.js#L535-L555)
* **Description**: Dynamic client-side encryption processes hang indefinitely if workers fail to load or execute.
* **Root Cause**: The promise returned by `encryptFileClientSide` does not register a `worker.onerror` handler. If the worker fails (due to CSP restrictions, network problems, etc.), the promise never resolves or rejects, leaving the file upload state stuck in a perpetual loading state.
* **Suggested Fix**: Add a `worker.onerror` handler to reject the promise and terminate the worker:
  ```diff
  async function encryptFileClientSide(file, key = null) {
    return new Promise((resolve, reject) => {
      const worker = new Worker("/static/js/aead-worker.js");
  +   worker.onerror = (e) => {
  +     worker.terminate();
  +     reject(new Error(e.message || "Encryption worker error"));
  +   };
      const reader = new FileReader();
  ```

---

### 6.4 DOM Input Element Leak on Cancelled Directory File Selection
* **File Path**: [files.js](file:///c:/Users/fagol/Documents/fuck/fileupload/app/static/js/files.js#L413-L470)
* **Description**: Multiple dynamically created, hidden `<input type="file">` elements are leaked in the document body.
* **Root Cause**: In `addFilesToDirectory`, the temporary input element is appended to `document.body` and only removed inside the `change` event listener. If the user cancels the file dialog, the `change` event never fires, leaving the hidden element attached to the page.
* **Suggested Fix**: Remove the input element from the DOM immediately after invoking the synchronous `click()` method:
  ```diff
    document.body.appendChild(input);
    input.click();
  + input.remove();
    input.addEventListener("change", async () => {
      const files = Array.from(input.files || []);
  -   input.remove();
      if (!files.length) return;
  ```

---

### 6.5 Fragile Fixed-Timeout Logic for Image Preview Error Handling
* **File Path**: [download.js](file:///c:/Users/fagol/Documents/fuck/fileupload/app/static/js/download.js#L283-L289)
* **Description**: Image previews fail to remove the broken layout frame on slow connections.
* **Root Cause**: The UI checks `img.onerror` inside a fixed 3-second `setTimeout`. If network latency causes loading to fail after 3 seconds, the check runs too early and the broken frame is never cleaned up.
* **Suggested Fix**: Remove the timeout entirely and handle removing the preview wrap directly in the `onerror` event callback:
  ```diff
      const img = document.createElement("img");
      img.alt  = filename;
      img.src  = rawSrc;
      img.style.cssText = "display:block;max-width:100%;max-height:480px;object-fit:contain;margin:0 auto;";
  -   let errored = false;
  -   img.onerror = () => { errored = true; };
      body = document.createElement("div");
      body.className = "preview-body";
      body.appendChild(img);
  -   // Remove whole wrap if image fails
  -   setTimeout(() => { if (errored && body.parentElement) body.parentElement.remove(); }, 3000);
  +   img.onerror = () => {
  +     if (body.parentElement) body.parentElement.remove();
  +   };
  ```

---

### 6.6 Unhandled Promise Rejections on Clipboard Write Failures
* **File Paths**: 
  - [files.js](file:///c:/Users/fagol/Documents/fuck/fileupload/app/static/js/files.js#L625)
  - [download.js](file:///c:/Users/fagol/Documents/fuck/fileupload/app/static/js/download.js#L242)
* **Description**: Clicking copy-to-clipboard elements can crash the client script or throw unhandled exceptions.
* **Root Cause**: Clipboard write operations `navigator.clipboard.writeText(...)` are invoked without `.catch()` blocks. If the connection is insecure (HTTP) or clipboard permissions are denied, the promise rejection crashes the thread.
* **Suggested Fix**: Chain a `.catch(() => {})` block onto all clipboard write operations.

---

## 7. Admin Dashboard & Account Administration (`app/static/js/admin.js`, `app/static/css/theme.css`)

### 7.1 Permissions Modal Silently Revoking Permissions
* **File Path**: [admin.js](file:///c:/Users/fagol/Documents/fuck/fileupload/app/static/js/admin.js#L222-L223)
* **Description**: Opening the permissions modal for a user and clicking "Save" silently revokes the "Can regenerate links" and "Can use API keys" permissions.
* **Root Cause**: The checkboxes in the permissions modal are initialized using the properties `p.can_regen` and `p.can_api`. However, the API returns these fields as `can_regenerate_links` and `can_use_api_keys`. Since the properties are undefined, the checkboxes initialize as unchecked. Clicking "Save" submits the unchecked states to the server, revoking the permissions.
* **Suggested Fix**:
  ```diff
  - document.getElementById("perm-can-regen").checked  = !!p.can_regen;
  - document.getElementById("perm-can-api").checked    = !!p.can_api;
  + document.getElementById("perm-can-regen").checked  = !!p.can_regenerate_links;
  + document.getElementById("perm-can-api").checked    = !!p.can_use_api_keys;
  ```

---

### 7.2 Stale Statistics Display in Admin Panel
* **File Path**: [admin.js](file:///c:/Users/fagol/Documents/fuck/fileupload/app/static/js/admin.js#L21-L30)
* **Description**: Switching tabs in the admin panel displays stale user storage quotas and file counts.
* **Root Cause**: When switching between tabs, the click listener triggers data fetching for files, keys, and audit entries, but lacks a clause to reload user statistics when clicking the "Users" tab.
* **Suggested Fix**:
  ```diff
      if (tab.dataset.tab === "audit") loadAudit();
      if (tab.dataset.tab === "files") loadAdminFiles();
      if (tab.dataset.tab === "keys") loadKeys();
  +   if (tab.dataset.tab === "users") loadUsers();
  ```

---

### 7.3 Double Tooltip Rendering Conflict
* **File Paths**:
  - [theme.css](file:///c:/Users/fagol/Documents/fuck/fileupload/app/static/css/theme.css#L761-L801)
  - [api.js](file:///c:/Users/fagol/Documents/fuck/fileupload/app/static/js/api.js#L282-L297)
* **Description**: Hovering over tooltip elements displays duplicate text bubbles stacked on top of each other.
* **Root Cause**: Both the JavaScript custom tooltip engine in `api.js` and the CSS pseudo-element tooltips in `theme.css` bind to the same `.help-icon[data-tip]` selector, rendering two overlapping layers.
* **Suggested Fix**: Remove the hover opacity visibility rules for pseudo-elements in `theme.css` and let `api.js` handle it exclusively:
  ```diff
  - .help-icon:hover::after,
  - .help-icon:hover::before { opacity: 1; }
  ```

---

### 7.4 Incorrect Range Display for Empty Audit Log
* **File Path**: [admin.js](file:///c:/Users/fagol/Documents/fuck/fileupload/app/static/js/admin.js#L778-L780)
* **Description**: When the audit log is empty, the UI pagination range renders as `1–0`.
* **Root Cause**: The string formatter does not handle the case when `auditEntries.length` is 0, assuming there is always at least one entry.
* **Suggested Fix**: Check if `auditEntries` is empty, displaying `0–0` in that case:
  ```diff
  -   document.getElementById("audit-page").textContent =
  -     `${auditOffset + 1}–${auditOffset + auditEntries.length}${matchNote}`;
  +   const totalShown = auditEntries.length;
  +   const rangeText = totalShown > 0 ? `${auditOffset + 1}–${auditOffset + totalShown}` : "0–0";
  +   document.getElementById("audit-page").textContent = `${rangeText}${matchNote}`;
  ```
