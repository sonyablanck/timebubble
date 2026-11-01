"""Run the whole fossil pipeline (steps 2–5) and rebuild the manifest.

  python -m pipeline.fossils --from-file pbdb.csv    # a PBDB CSV you downloaded in a browser
  python -m pipeline.fossils                         # or download it (needs internet)
"""
from __future__ import annotations

import argparse
from pathlib import Path

from . import bin_occurrences, build_manifest, classify_taxa, ingest_pbdb, rotate

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from-file", type=Path)
    a = ap.parse_args()
    ingest_pbdb.run(a.from_file)
    rotate.run()
    classify_taxa.run()
    bin_occurrences.run()
    build_manifest.main([])
