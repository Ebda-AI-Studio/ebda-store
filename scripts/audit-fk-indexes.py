#!/usr/bin/env python3
"""Audit every foreign key in schema.prisma for leading-column index coverage.

Postgres indexes the *referenced* side of a foreign key (the parent's PK) and
nothing on the *referencing* side. Every parent delete/update then fires an RI
trigger that filters the child on the FK column ALONE:

    UPDATE <child> SET <fk> = NULL WHERE <fk> = $1   -- onDelete: SetNull
    DELETE FROM <child>            WHERE <fk> = $1   -- onDelete: Cascade

A btree can only be range-scanned from its leading column inward, so a composite
`(store_id, group_id)` does NOT serve a filter on `group_id` alone. Without an
index whose LEADING column is the FK, that trigger seq-scans the child table
while holding the parent row's lock.

Static check — no database connection. Exits 1 if any FK is uncovered.

Usage:  python3 scripts/audit-fk-indexes.py [path/to/schema.prisma]

Background: docs/perf/index-audit-2026-08-fk-coverage.md
"""

import re
import sys
from pathlib import Path

DEFAULT_SCHEMA = Path(__file__).resolve().parent.parent / "packages/database/prisma/schema.prisma"

MODEL_RE = re.compile(r"^model (\w+) \{(.*?)^\}", re.S | re.M)
RELATION_RE = re.compile(r"@relation\([^)]*fields:\s*\[([^\]]+)\]")
BLOCK_ATTR_RE = re.compile(r"@@(?:index|unique|id)\(\s*\[([^\]]+)\]")
# Strips modifiers Prisma allows on an index column, e.g. `createdAt(sort: Desc)`.
COLUMN_RE = re.compile(r"^(\w+)")


def leading_column(column_list: str) -> str:
    """First column of a bracketed index/relation list, modifiers stripped."""
    first = column_list.split(",")[0].strip()
    match = COLUMN_RE.match(first)
    return match.group(1) if match else first


def indexed_leading_columns(body: str) -> set[str]:
    """Every column that leads some index on this model."""
    leads = {leading_column(m.group(1)) for m in BLOCK_ATTR_RE.finditer(body)}

    # Field-level `@id` / `@unique` each create a single-column index.
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith(("@@", "//", "///")):
            continue
        if "@unique" in stripped or "@id" in stripped:
            leads.add(stripped.split()[0])

    return leads


def audit(schema_path: Path) -> list[tuple[str, str]]:
    source = schema_path.read_text()
    gaps: list[tuple[str, str]] = []

    for model_name, body in MODEL_RE.findall(source):
        leads = indexed_leading_columns(body)
        for relation in RELATION_RE.finditer(body):
            fk = leading_column(relation.group(1))
            if fk not in leads:
                gaps.append((model_name, fk))

    return gaps


def main() -> int:
    schema_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SCHEMA
    if not schema_path.is_file():
        print(f"schema not found: {schema_path}", file=sys.stderr)
        return 2

    gaps = audit(schema_path)
    model_count = len(MODEL_RE.findall(schema_path.read_text()))

    if not gaps:
        print(f"OK — every foreign key across {model_count} models leads an index.")
        return 0

    print(f"{len(gaps)} foreign key(s) with no leading-column index:\n")
    for model_name, fk in gaps:
        print(f"  {model_name}.{fk}")
    print(
        "\nEach one seq-scans its table on parent delete. Add `@@index([<fk>])` to "
        "the model\nand a matching CREATE INDEX migration, or document here why the "
        "scan is acceptable."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
