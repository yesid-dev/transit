"""Print aggregate evidence for a runner-local clean day."""

import argparse
import json
import sys
from pathlib import Path
from typing import TextIO

import duckdb
from botocore.exceptions import BotoCoreError, ClientError

from transit_ops.clean_day_evidence import report_details
from transit_ops.clean_day_output import version_key
from transit_ops.clean_days import _failure_reason, parse_date
from transit_ops.lake.archive_keys import validate_provider_id
from transit_ops.s3 import ObjectStorageError


def summarize(directory: Path, output: TextIO, *, source: str | None = None) -> bool:
    receipt = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    print(f"## Private clean day {receipt['provider']}, {receipt['service_date']}\n", file=output)
    if "status" in receipt:
        print(f"Recorded as unmeasured: `{receipt['status']}`.\n", file=output)
        return False

    print(f"Cleaning version {receipt['cleaning_version']}.", file=output)
    print(f"Builder commit `{receipt.get('builder_git_commit') or 'unavailable'}`.", file=output)
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
        if source is not None:
            lines = db.execute(
                """
                SELECT route_id, count(first_capture_utc) AS observations
                FROM read_parquet(?) WHERE state <> 'added' AND route_id IS NOT NULL
                GROUP BY route_id ORDER BY route_id
                """,
                [str(directory / "trip_days.parquet")],
            ).fetchall()
            silent = [line for line, count in lines if not count]
            if lines:
                print(
                    f"Scheduled lines with a capture: {len(lines) - len(silent)}/{len(lines)}.",
                    file=output,
                )
                if silent:
                    print(f"Scheduled lines without a capture: {json.dumps(silent)}.", file=output)

            gaps = db.execute(
                """
                WITH successful AS (
                    SELECT feed, captured_at_utc,
                           epoch(captured_at_utc - lag(captured_at_utc)
                               OVER (PARTITION BY feed ORDER BY captured_at_utc)) AS gap,
                           epoch(captured_at_utc - feed_timestamp_utc) AS source_age
                    FROM read_parquet(?) WHERE result IN ('ok', 'empty', 'duplicate')
                )
                SELECT feed, min(captured_at_utc) AT TIME ZONE 'UTC',
                       max(captured_at_utc) AT TIME ZONE 'UTC',
                       max(gap), min(source_age), max(source_age)
                FROM successful GROUP BY feed ORDER BY feed
                """,
                [str(directory / "feed_polls.parquet")],
            ).fetchall()
            print("\nSuccessful polls: largest gap and source age, in seconds.", file=output)
            for feed, first, last, gap, age_min, age_max in gaps:
                largest = "unavailable" if gap is None else f"{gap:g}"
                age = "unavailable" if age_min is None else f"{age_min:g} to {age_max:g}"
                print(
                    f"  {feed}: {first} to {last} UTC, largest gap {largest}, source age {age}.",
                    file=output,
                )
            if not gaps:
                print("  No successful poll evidence.", file=output)
    if source is not None:
        report_details(
            directory,
            receipt["provider"],
            parse_date(receipt["service_date"]),
            source,
            receipt["schedule_sha256"],
            output,
        )
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--provider", required=True)
    parser.add_argument("--day", required=True, type=parse_date)
    parser.add_argument("--details", action="store_true", help="Read raw evidence privately")
    parser.add_argument("--source", help="Read-only raw capture root for --details")
    args = parser.parse_args()
    if args.details != (args.source is not None):
        parser.error("--details and --source must be used together")
    try:
        validate_provider_id(args.provider)
        directory = args.root / version_key(args.provider, args.day)
        return 0 if summarize(directory, sys.stdout, source=args.source) else 1
    except (OSError, ValueError, BotoCoreError, ClientError, ObjectStorageError) as error:
        print(_failure_reason(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
