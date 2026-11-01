"""Deterministic writers and readers for pipeline output.

Every writer here produces byte-identical files for identical inputs
(gzip mtime=0 and no embedded filename; JSON with sorted keys), so
regenerating data never creates spurious git changes (DESIGN §5).
"""
from __future__ import annotations

import gzip
import io
import json
from pathlib import Path

import numpy as np

from pipeline import config

INT16_MIN, INT16_MAX = -32768, 32767


def to_int16(values: np.ndarray) -> np.ndarray:
    """Round to nearest (ties to even, numpy's rint) and clip to int16."""
    arr = np.asarray(values, dtype=np.float64)
    if not np.all(np.isfinite(arr)):
        raise ValueError("to_int16: input contains NaN or infinity")
    return np.clip(np.rint(arr), INT16_MIN, INT16_MAX).astype("<i2")


def gzip_bytes(raw: bytes) -> bytes:
    buf = io.BytesIO()
    # filename="" and mtime=0 keep the header identical between runs
    with gzip.GzipFile(filename="", mode="wb", fileobj=buf,
                       compresslevel=config.GZIP_LEVEL, mtime=0) as gz:
        gz.write(raw)
    return buf.getvalue()


def write_int16(path: Path, values: np.ndarray) -> np.ndarray:
    """Write a 2D grid as gzipped little-endian int16, row-major. Returns the stored array."""
    stored = to_int16(values)
    _write_bytes(path, gzip_bytes(np.ascontiguousarray(stored).tobytes()))
    return stored


def read_int16(path: Path, shape: tuple[int, int]) -> np.ndarray:
    raw = gzip.decompress(Path(path).read_bytes())
    expected = shape[0] * shape[1] * 2
    if len(raw) != expected:
        raise ValueError(f"{path}: {len(raw)} bytes, expected {expected} for shape {shape}")
    return np.frombuffer(raw, dtype="<i2").reshape(shape)


def write_json(path: Path, obj) -> None:
    text = json.dumps(obj, sort_keys=True, indent=1, ensure_ascii=False,
                      default=_json_default) + "\n"
    _write_bytes(path, text.encode("utf-8"))


def read_json(path: Path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _json_default(o):
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.floating):
        return float(o)
    if isinstance(o, Path):
        return o.as_posix()
    raise TypeError(f"not JSON serialisable: {type(o)}")


def _write_bytes(path: Path, data: bytes) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # skip rewriting identical files so mtimes stay stable for build tools
    if path.exists() and path.read_bytes() == data:
        return
    path.write_bytes(data)
