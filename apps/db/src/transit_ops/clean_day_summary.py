"""Print aggregate evidence for a runner-local clean day."""

import argparse
import json
import sys
from pathlib import Path
from typing import TextIO

import duckdb

from transit_ops.clean_day_output import version_key
from transit_ops.clean_days import parse_date


def summarize(directory: Path, output: TextIO) -> bool:
    receipt = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    print(f"## Private clean day {receipt['provider']}, {receipt['service_date']}\n", file=output)
    if "status" in receipt:
        print(f"Recorded as unmeasured: `{receipt['status']}`.\n", file=output)
        return False

    print(f"Cleaning version {receipt['cleaning_version']}.", file=output)
    print(f"Builder commit `{receipt.get('builder_git_commit', 'unavailable')}`.", file=output)
    print(f"Schedule SHA-256 `{receipt['schedule_sha256']}`.", file=output)
    print(f"Source date: {receipt.get('source_date', 'unavailable')}.\n", file=output)
    print("| Table | Rows | Bytes |\n| --- | ---: | ---: |", file=output)
    for name, entry in sorted(receipt["files"].items()):
        print(f"| {name} | {entry['rows']} | {entry['byte_size']} |", file=output)
    if receipt.get("alerts") == "not_tracked":
        print("\nAlerts were not tracked.", file=output)
    for label, field in (("Trip states", "state"), ("Stop observation bases", "basis")):
        counts = receipt[f"row_counts_by_{field}"]
        values = ", ".join(f"`{name}` {count}" for name, count in sorted(counts.items()))
        print(f"\n**{label}** {values or 'No rows'}.", file=output)

    with duckdb.connect(config={"TimeZone": "UTC"}) as db:
        counts = db.execute(
            """
            SELECT count(*) FILTER (WHERE state <> 'added'),
                   count(*) FILTER (WHERE NOT route_has_live_data),
                   count(*) FILTER (WHERE state = 'ran'),
                   count(*) FILTER (WHERE state = 'ran' AND vehicle_id IS NULL)
            FROM read_parquet(?)
            """,
            [str(directory / "trip_days.parquet")],
        ).fetchone()
        assert counts is not None
        scheduled, schedule_only, ran, no_vehicle = counts
        print(
            f"\n**Scheduled trips** {scheduled}, including {schedule_only} schedule-only.",
            file=output,
        )
        if ran:
            print(f"**Ran with no vehicle ID** {no_vehicle} of {ran}.", file=output)
        else:
            print("**Ran with no vehicle ID** Unavailable. No trips marked ran.", file=output)

        polls = db.execute(
            """
            SELECT feed, result, count(*),
                   min(captured_at_utc) AT TIME ZONE 'UTC',
                   max(captured_at_utc) AT TIME ZONE 'UTC'
            FROM read_parquet(?) GROUP BY feed, result ORDER BY feed, result
            """,
            [str(directory / "feed_polls.parquet")],
        ).fetchall()
        print("\n### Realtime polls\n", file=output)
        if not polls:
            print("No poll evidence was recorded.", file=output)
        else:
            print("| Feed | Result | Polls | First UTC | Last UTC |", file=output)
            print("| --- | --- | ---: | --- | --- |", file=output)
            for feed, result, count, first, last in polls:
                print(f"| {feed} | {result} | {count} | {first} | {last} |", file=output)
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--provider", required=True)
    parser.add_argument("--day", required=True, type=parse_date)
    args = parser.parse_args()
    return 0 if summarize(args.root / version_key(args.provider, args.day), sys.stdout) else 1


if __name__ == "__main__":
    raise SystemExit(main())
