"""Pipeline step 4: map each occurrence to a body-plan class (pipeline §4).

Rules come from pipeline/rules.csv, matched most specific first (genus, family, order, class,
phylum). Unmapped taxa are written to pipeline/review/unmapped_taxa.csv with counts, never guessed.

  python -m pipeline.classify_taxa     # raw/rotated/{age}.json.gz → raw/classified/{age}.json.gz
"""
from __future__ import annotations

import csv
import gzip
import json
from collections import Counter
from pathlib import Path

from .config import DATA_RAW, REPO_ROOT, slices
from .io_util import gzip_bytes, write_json

RULES_FILE = REPO_ROOT / "pipeline" / "rules.csv"
REVIEW_FILE = REPO_ROOT / "pipeline" / "review" / "unmapped_taxa.csv"
CLASSIFIED_DIR = DATA_RAW / "classified"
LEVELS = ["genus", "family", "order", "class", "phylum"]

BODY_PLANS = {
    "small_theropod", "large_theropod", "sauropod", "prosauropod", "ornithopod", "ceratopsian", "ankylosaur",
    "stegosaur", "pterosaur", "crocodylomorph", "marine_reptile", "turtle", "small_tetrapod", "fish", "invertebrate",
    "conifer", "cycad_bennettitalean", "ginkgo", "fern", "horsetail", "early_angiosperm", "seed_fern",
    "skip",
}
DINOSAUR_PLANS = {"small_theropod", "large_theropod", "sauropod", "prosauropod", "ornithopod", "ceratopsian", "ankylosaur", "stegosaur"}


def field(o: dict, key: str) -> str:
    """A taxonomy field, with PBDB's NO_ORDER_SPECIFIED-style placeholders read as empty."""
    v = (o.get(key) or "").strip()
    return "" if v.startswith("NO_") and v.endswith("_SPECIFIED") else v


def load_rules(path: Path = RULES_FILE) -> dict[tuple[str, str], tuple[str, float | None]]:
    rules: dict[tuple[str, str], tuple[str, float | None]] = {}
    with open(path, encoding="utf-8") as f:
        lines = [ln for ln in f if ln.strip() and not ln.startswith("#")]
    for r in csv.DictReader(lines):
        level, name, plan = r["level"].strip(), r["name"].strip(), r["body_plan"].strip()
        if level not in LEVELS:
            raise ValueError(f"rules.csv: unknown level {level!r} for {name}")
        if plan not in BODY_PLANS:
            raise ValueError(f"rules.csv: unknown body plan {plan!r} for {name}")
        if (level, name) in rules:
            raise ValueError(f"rules.csv: duplicate rule for {level} {name}")
        size = r.get("size_hint", "").strip()
        rules[(level, name)] = (plan, float(size) if size else None)
    return rules


def classify(o: dict, rules) -> tuple[str, float | None, str] | None:
    # genus comes from the accepted name when PBDB leaves the genus field empty
    genus = field(o, "genus") or (o.get("accepted_name") or "").split(" ")[0]
    for level in LEVELS:
        name = genus if level == "genus" else field(o, level)
        if name and (level, name) in rules:
            plan, size = rules[(level, name)]
            return plan, size, level
    return None


def classify_all(by_age: dict[int, list[dict]], rules) -> tuple[dict[int, list[dict]], Counter, dict]:
    unmapped: Counter = Counter()
    out: dict[int, list[dict]] = {}
    report = {}
    for age, occ in by_age.items():
        kept, skipped = [], 0
        for o in occ:
            c = classify(o, rules)
            if c is None:
                unmapped[tuple(field(o, k) for k in ("phylum", "class", "order", "family"))] += 1
                continue
            if c[0] == "skip":
                skipped += 1
                continue
            kept.append({**o, "body_plan": c[0], "size_hint": c[1], "matched_level": c[2]})
        out[age] = kept
        report[age] = {"classified": len(kept), "skipped_on_purpose": skipped, "unmapped": len(occ) - len(kept) - skipped}
    return out, unmapped, report


def write_review(unmapped: Counter, path: Path = REVIEW_FILE) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["phylum", "class", "order", "family", "occurrences"])
        for key, n in sorted(unmapped.items(), key=lambda kv: (-kv[1], kv[0])):
            w.writerow([*key, n])


def run() -> dict:
    from .rotate import read_rotated
    rules = load_rules()
    by_age = {age: read_rotated(age) for age in slices()}
    out, unmapped, report = classify_all(by_age, rules)
    CLASSIFIED_DIR.mkdir(parents=True, exist_ok=True)
    for age, rows in out.items():
        (CLASSIFIED_DIR / f"{age}.json.gz").write_bytes(gzip_bytes(json.dumps(rows, sort_keys=True, separators=(",", ":")).encode()))
    write_review(unmapped)
    write_json(CLASSIFIED_DIR / "classify_report.json", report)
    print(f"classified; {sum(unmapped.values())} occurrence-slices unmapped across {len(unmapped)} taxa → {REVIEW_FILE}")
    return report


def read_classified(age: int, in_dir: Path = CLASSIFIED_DIR) -> list[dict]:
    with gzip.open(in_dir / f"{age}.json.gz", "rt", encoding="utf-8") as f:
        return json.load(f)


if __name__ == "__main__":
    run()
