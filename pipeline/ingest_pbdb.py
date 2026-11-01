"""Pipeline step 2: Mesozoic fossil occurrences from the Paleobiology Database (pipeline §2).

Two ways in:
  python -m pipeline.ingest_pbdb                 # download (needs internet; one large request)
  python -m pipeline.ingest_pbdb --from-file F   # use a CSV you downloaded from PBDB_URL in a browser

Writes, under pipeline/raw/pbdb/:
  pbdb_raw.csv            the download as received
  pbdb_query.json         URL, retrieval time, licence and record count as PBDB stated them (for CREDITS)
  pbdb_clean.csv.gz       cleaned rows (deterministic gzip)
  pbdb_clean_report.json  rows dropped at each step
"""
from __future__ import annotations

import argparse
import csv
import gzip
import io
import shutil
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from .config import DATA_RAW, KPG_MA, SLICE_HALF_WINDOW, SLICE_MAX_MA, SLICE_MIN_MA
from .io_util import gzip_bytes, write_json

PBDB_DIR = DATA_RAW / "pbdb"

# The oldest slice's window reaches 252.5 Ma; the youngest is clipped at 62.5 Ma (K–Pg rule, §3).
MIN_MA = SLICE_MIN_MA - SLICE_HALF_WINDOW
MAX_MA = SLICE_MAX_MA + SLICE_HALF_WINDOW
PBDB_URL = (
    "https://paleobiodb.org/data1.2/occs/list.csv"
    f"?min_ma={MIN_MA:g}&max_ma={MAX_MA:g}&timerule=overlap"
    "&show=class,coords,env&vocab=pbdb&limit=all&datainfo"
)

FIELDS = ["occurrence_no", "collection_no", "reference_no", "accepted_name", "accepted_rank",
          "phylum", "class", "order", "family", "genus", "lng", "lat", "max_ma", "min_ma", "environment"]

# Ranks precise enough to place and render (family or finer); coarser rows are dropped (§2).
KEEP_RANKS = {"subspecies", "species", "subgenus", "genus", "subtribe", "tribe", "subfamily", "family"}


def split_datainfo(text: str) -> tuple[dict[str, str], str]:
    """PBDB's `datainfo` puts metadata lines before the header row. Return (metadata, csv body)."""
    lines = text.splitlines(keepends=True)
    meta: dict[str, str] = {}
    for i, line in enumerate(lines):
        row = next(csv.reader([line]), [])
        if "occurrence_no" in row:
            return meta, "".join(lines[i:])
        if len(row) >= 2 and row[0]:
            meta[row[0].strip()] = row[1].strip()
        elif len(row) >= 3 and row[1]:            # parameter lines: "","name","value"
            meta[f"param:{row[1].strip()}"] = row[2].strip()
    raise ValueError("no header row with 'occurrence_no' found: is this a PBDB occurrence CSV?")


def clean(rows: list[dict[str, str]]) -> tuple[list[dict[str, str]], dict[str, int]]:
    report = {"input": len(rows)}

    def num(x: str) -> float | None:
        try:
            return float(x)
        except (TypeError, ValueError):
            return None

    out = [r for r in rows if None not in (num(r.get("lat")), num(r.get("lng")), num(r.get("max_ma")), num(r.get("min_ma")))]
    report["dropped_missing_coords_or_ages"] = report["input"] - len(out)
    n = len(out)
    out = [r for r in out if (r.get("accepted_rank") or "").strip() in KEEP_RANKS]
    report["dropped_rank_coarser_than_family"] = n - len(out)
    n = len(out)
    seen: set[tuple[str, str]] = set()
    dedup = []
    for r in out:
        key = (r["collection_no"], r["accepted_name"])
        if key in seen:
            continue
        seen.add(key)
        dedup.append(r)
    report["dropped_duplicates_in_collection"] = n - len(dedup)
    bad = [r for r in dedup if float(r["max_ma"]) < float(r["min_ma"])]
    if bad:
        raise ValueError(f"{len(bad)} rows have max_ma < min_ma (first: occurrence {bad[0]['occurrence_no']})")
    report["output"] = len(dedup)
    return dedup, report


def write_clean(path: Path, rows: list[dict[str, str]]) -> None:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=FIELDS, extrasaction="ignore", lineterminator="\n")
    w.writeheader()
    for r in sorted(rows, key=lambda r: int(r["occurrence_no"])):
        w.writerow({k: r.get(k, "") for k in FIELDS})
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip_bytes(buf.getvalue().encode("utf-8")))


def read_clean(path: Path = PBDB_DIR / "pbdb_clean.csv.gz") -> list[dict[str, str]]:
    with gzip.open(path, "rt", encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def download(dest: Path, url: str = PBDB_URL, attempts: int = 4) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    for k in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "TimeBubble-pipeline/0.1"})
            with urllib.request.urlopen(req, timeout=600) as r, open(dest, "wb") as f:
                shutil.copyfileobj(r, f)
            return
        except Exception as e:  # network errors: back off and retry
            if k == attempts - 1:
                raise
            wait = 10 * 2 ** k
            print(f"download failed ({e}); retrying in {wait} s", file=sys.stderr)
            time.sleep(wait)


def run(from_file: Path | None = None, out_dir: Path = PBDB_DIR) -> dict:
    raw = out_dir / "pbdb_raw.csv"
    if from_file:
        out_dir.mkdir(parents=True, exist_ok=True)
        if Path(from_file).resolve() != raw.resolve():
            shutil.copyfile(from_file, raw)
    else:
        print(f"downloading {PBDB_URL}")
        download(raw)
    meta, body = split_datainfo(raw.read_text(encoding="utf-8-sig"))
    rows = list(csv.DictReader(io.StringIO(body)))
    missing = [f for f in FIELDS if rows and f not in rows[0]]
    if missing:
        raise ValueError(f"PBDB CSV lacks fields {missing}; was it downloaded with show=class,coords,env&vocab=pbdb?")
    cleaned, report = clean(rows)
    write_clean(out_dir / "pbdb_clean.csv.gz", cleaned)
    write_json(out_dir / "pbdb_clean_report.json", report)
    query = {
        "url": PBDB_URL if not from_file else meta.get("Data URL", PBDB_URL),
        "access_time": meta.get("Access Time"),
        "retrieved_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "data_license": meta.get("Data License"),
        "license_url": meta.get("License URL"),
        "records_found": meta.get("Records Found"),
        "rows_in_file": len(rows),
        "kpg_ma": KPG_MA,
    }
    write_json(out_dir / "pbdb_query.json", query)
    print(f"PBDB: {len(rows)} rows → {len(cleaned)} after cleaning; licence stated: {query['data_license']}")
    return report


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from-file", type=Path, help="a PBDB occurrence CSV downloaded from the URL printed by --print-url")
    ap.add_argument("--print-url", action="store_true", help="print the download URL and exit")
    a = ap.parse_args()
    if a.print_url:
        print(PBDB_URL)
    else:
        run(a.from_file)
