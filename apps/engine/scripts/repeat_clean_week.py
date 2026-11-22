"""Repeat seven local v7 clean days across a benchmark range.

Run from apps/engine with `uv run --locked python scripts/repeat_clean_week.py`.
Pass a source root with one measured day per weekday, a new output root, provider,
and the first target date. Output is synthetic and intended for local timing only.
"""

import argparse
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from hashlib import file_digest
from pathlib import Path

import duckdb

from transit_engine.clean_manifest import file_identities

# DuckDB supplies the timezone database on Windows as well as Linux.
_ANCHOR = "SELECT epoch(timezone('America/Toronto', ?::TIMESTAMP + INTERVAL '12 hours'))::BIGINT"


def repeat_day(source: Path, output: Path, day: date) -> None:
    original = date.fromisoformat(source.parent.name)
    manifest = json.loads((source / "manifest.json").read_bytes())
    destination = output / manifest["provider"] / day.isoformat() / "v7"
    destination.mkdir(parents=True)
    with duckdb.connect(config={"threads": 1, "TimeZone": "UTC"}) as conn:
        old_anchor = conn.execute(_ANCHOR, [original]).fetchall()[0][0]
        new_anchor = conn.execute(_ANCHOR, [day]).fetchall()[0][0]
        interval = new_anchor - old_anchor
        shift = timedelta(seconds=interval)
        manifest["service_date"] = day.isoformat()
        built = datetime.fromisoformat(manifest["built_at_utc"])
        manifest["built_at_utc"] = (built + shift).isoformat()
        metadata = {
            key: manifest[key]
            for key in ("provider", "service_date", "cleaning_version", "schedule_sha256")
        }
        for name, entry in manifest["files"].items():
            source_file = (source / name).as_posix()
            target = destination / name
            relation = conn.read_parquet(source_file, hive_partitioning=False)
            replacements = []
            step = f"INTERVAL '{interval} seconds'"
            for column, kind in zip(relation.columns, relation.types, strict=True):
                if str(kind) == "TIMESTAMP WITH TIME ZONE":
                    replacements.append(f'"{column}" + {step} AS "{column}"')
                elif column == "service_date":
                    replacements.append(f"service_date + {(day - original).days} AS service_date")
                elif column == "active_periods":
                    replacements.append(
                        "list_transform(active_periods, lambda p: struct_pack("
                        f"start_utc := p.start_utc + {step}, end_utc := p.end_utc + {step}"
                        ")) AS active_periods"
                    )
            projection = f"* REPLACE ({', '.join(replacements)})"
            conn.execute(
                f"COPY (SELECT {projection} FROM read_parquet(?, hive_partitioning = false)) "
                "TO ? (FORMAT PARQUET, COMPRESSION zstd, ROW_GROUP_SIZE 122880, KV_METADATA ?)",
                [source_file, target.as_posix(), metadata],
            )
            with target.open("rb") as stream:
                entry["sha256"] = file_digest(stream, "sha256").hexdigest()
            entry["byte_size"] = target.stat().st_size
    (destination / "manifest.json").write_text(json.dumps(manifest) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("provider")
    parser.add_argument("start", type=date.fromisoformat)
    parser.add_argument("--days", type=int, default=365)
    args = parser.parse_args()

    week = {}
    for marker in (args.source / args.provider).glob("*/v7/manifest.json"):
        day = date.fromisoformat(marker.parent.parent.name)
        if file_identities(marker.read_bytes(), args.provider, day.isoformat(), "7"):
            if day.weekday() in week:
                parser.error("provide exactly one measured source day per weekday")
            week[day.weekday()] = marker.parent
    if len(week) != 7 or args.days < 1 or args.output.exists():
        parser.error("provide seven measured weekdays, a positive span and a new output root")

    with ThreadPoolExecutor(max_workers=4) as workers:
        days = [args.start + timedelta(days=offset) for offset in range(args.days)]
        batches = [
            workers.submit(repeat_day, week[day.weekday()], args.output, day) for day in days
        ]
        for index, batch in enumerate(batches, 1):
            batch.result()
            if index % 30 == 0 or index == len(days):
                print(f"Wrote {index}/{len(days)} days", flush=True)


if __name__ == "__main__":
    main()
