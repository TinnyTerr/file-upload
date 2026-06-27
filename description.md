# Oxymoron (for files)

Package name: `fileupload`

Oxymoron is a private file upload and sharing web app built with FastAPI, SQLAlchemy, and vanilla HTML/CSS/JavaScript. It is designed around controlled uploads, random share links, admin-managed users, optional encryption, and storage lifecycle management.

## Features Overview

- User authentication with a bootstrapped master account, session cookies, CSRF protection, login lockout, and forced credential changes.
- Role and permission controls for uploading, deleting, link management, directory creation, lifecycle tools, API keys, user management, storage management, and admin access.
- File uploads through normal multipart upload and chunked/resumable upload for large files.
- Per-user storage quotas, max file-size limits, global storage quota controls, and storage usage reporting.
- File management for listing files, deleting files, randomized filenames, and owner/admin visibility.
- Random share links with public download pages, raw download URLs, max-use limits, expiry, activation controls, and link editing.
- Download support with metadata endpoints, streaming responses, safe content-disposition headers, and byte-range support for plain files.
- Encryption modes for unencrypted files, server-side encrypted files, and client-side encrypted files where the server never receives the client key.
- Optional compression plus archive/unarchive lifecycle support using zstandard.
- Shareable directory bundles with their own random URLs, optional shared encryption, member file management, public folder pages, and zip downloads.
- Admin panel features for users, permissions, quotas, storage summaries, lifecycle jobs, API keys, audit activity, and bulk operations.
- API key support with key creation, listing, deactivation, per-user active-key limits, bearer authentication, and IP binding/reset behavior.
- Audit logging with hash-chain verification support for important account, upload, download, link, admin, and lifecycle actions.
- Background lifecycle jobs for temporary file expiry, idle deletion, link expiry, idle archiving, stale upload cleanup, and storage-state reconciliation.
- Static web UI pages for login, credential changes, file management, admin management, public downloads, directory downloads, and API documentation.
- Security hardening including safe storage-path joining, unsafe content-type handling, response security headers, HTTPS redirects outside development, and hardened public download pages.
- Automated pytest coverage for authentication, permissions, uploads, downloads, links, directories, admin tools, API keys, encryption, compression, audit behavior, and lifecycle behavior.
