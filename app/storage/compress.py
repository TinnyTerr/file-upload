from __future__ import annotations

from pathlib import Path
from typing import Iterator

import zstandard as zstd

_NO_COMPRESS = frozenset({
    "image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp", "image/avif",
    "video/mp4", "video/webm", "video/ogg", "video/quicktime",
    "audio/mpeg", "audio/ogg", "audio/aac", "audio/flac",
    "application/zip", "application/gzip", "application/x-bzip2",
    "application/x-xz", "application/zstd", "application/x-7z-compressed",
    "application/x-rar-compressed", "application/vnd.rar",
    "font/woff", "font/woff2",
})

_LEVEL = 3
_BOMB_RATIO = 50
_BOMB_MAX = 10 * 1024 * 1024 * 1024  # 10 GiB
_READ_SIZE = 256 * 1024


def should_compress(content_type: str) -> bool:
    base = content_type.split(";")[0].strip().lower()
    return base not in _NO_COMPRESS


def compress_file(src: Path, dst: Path) -> int:
    cctx = zstd.ZstdCompressor(level=_LEVEL)
    with open(src, "rb") as fin, open(dst, "wb") as fout:
        cctx.copy_stream(fin, fout, read_size=_READ_SIZE, write_size=_READ_SIZE)
    return dst.stat().st_size


def decompress_stream(path: Path, original_size: int) -> Iterator[bytes]:
    dctx = zstd.ZstdDecompressor()
    produced = 0
    with open(path, "rb") as fh:
        reader = dctx.stream_reader(fh, read_size=_READ_SIZE)
        while True:
            chunk = reader.read(_READ_SIZE)
            if not chunk:
                break
            produced += len(chunk)
            if original_size > 0 and produced > original_size * _BOMB_RATIO:
                raise ValueError("decompression bomb detected")
            if produced > _BOMB_MAX:
                raise ValueError("decompression exceeded size cap")
            yield chunk
