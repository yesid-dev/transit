import argparse
import json
from datetime import date, timedelta
from pathlib import Path
from time import perf_counter
from typing import Any

from transit_engine.burst import measure_url, request
from transit_engine.store import CITY


def main() -> None:
    parser = argparse.ArgumentParser(description="Time the punctuality endpoint on real clean days")
    parser.add_argument("--url", default="http://127.0.0.1:8080")
    parser.add_argument("--city", required=True)
    parser.add_argument("--line", help="GTFS route ID. Omit for the network.")
    parser.add_argument("--end-date", type=date.fromisoformat, required=True)
    parser.add_argument("--spans", type=int, nargs="+", default=[1, 7, 30, 182, 365])
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    end: date = args.end_date
    spans: list[int] = sorted(set(args.spans))
    if not CITY.fullmatch(args.city) or not all(1 <= span <= end.toordinal() for span in spans):
        parser.error("provide a provider slug and positive spans within the calendar")

    timings: list[dict[str, Any]] = []
    failed = False
    for span in spans:
        start = end - timedelta(days=span - 1)
        url = measure_url(args.url, args.city, start, end, line=args.line)
        runs = []
        for _ in range(3):
            started = perf_counter()
            try:
                status, queued, body = request(url)
                elapsed = (perf_counter() - started) * 1000
                if status == 200 and body["measure"] == "punctuality":
                    evidence = body["evidence"]
                    failed |= bool(evidence["days_not_measured"])
                    runs.append(
                        {
                            "http_ms": elapsed,
                            "queued": queued,
                            "state": body["state"],
                            "query_ms": evidence["query_ms"],
                            "counts": evidence["counts"],
                            "days_not_measured": evidence["days_not_measured"],
                        }
                    )
                else:
                    runs.append({"http_ms": elapsed, "status": status})
                    failed = True
            except (KeyError, OSError, TypeError, ValueError) as error:
                runs.append({"error": type(error).__name__})
                failed = True
        timings.append(
            {
                "days": span,
                "start_date": start.isoformat(),
                "end_date": end.isoformat(),
                "runs": runs,
            }
        )
    report = {"city": args.city, "line": args.line, "end_date": end.isoformat(), "timings": timings}
    args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    if failed:
        raise SystemExit(1)
