import argparse
import json
from datetime import date, timedelta
from pathlib import Path
from time import perf_counter
from typing import Any
from urllib.parse import urlencode

from transit_engine.burst import request
from transit_engine.store import CITY


def main() -> None:
    parser = argparse.ArgumentParser(description="Time engine questions on clean days")
    parser.add_argument("--url", default="http://127.0.0.1:8080")
    parser.add_argument("--city", required=True)
    parser.add_argument("--line", help="GTFS route ID. Omit for the network.")
    parser.add_argument("--measure", help="Defaults to punctuality, or on_time for a ranking.")
    parser.add_argument("--kind", choices=("line", "stop", "departure"), help="Time a ranking.")
    parser.add_argument("--group", help="Time a measure series, e.g. weekday_hour.")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--end-date", type=date.fromisoformat, required=True)
    parser.add_argument("--spans", type=int, nargs="+", default=[1, 7, 30, 182, 365])
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    end: date = args.end_date
    spans: list[int] = sorted(set(args.spans))
    if not CITY.fullmatch(args.city) or not all(1 <= span <= end.toordinal() for span in spans):
        parser.error("provide a provider slug and positive spans within the calendar")
    if args.runs < 1 or args.timeout < 1 or (args.kind and args.group):
        parser.error("provide positive runs and timeout, and use group only for measures")

    timings: list[dict[str, Any]] = []
    failed = False
    measure = args.measure or ("on_time" if args.kind else "punctuality")
    route = "ranking" if args.kind else "measure"
    for span in spans:
        start = end - timedelta(days=span - 1)
        cuts = {"city": args.city, "from": start.isoformat(), "to": end.isoformat()}
        cuts["measure"] = measure
        for name in ("line", "group", "kind"):
            if value := getattr(args, name):
                cuts[name] = value
        url = f"{args.url.rstrip('/')}/{route}?{urlencode(cuts)}"
        runs = []
        for _ in range(args.runs):
            started = perf_counter()
            try:
                status, queued, body = request(url, timeout=args.timeout)
                elapsed = (perf_counter() - started) * 1000
                if status == 200 and body["measure"] == measure:
                    evidence = body["evidence"]
                    failed |= bool(evidence["days_not_measured"])
                    runs.append(
                        {
                            "http_ms": elapsed,
                            "queued": queued,
                            "state": body.get("state"),
                            "query_ms": evidence["query_ms"],
                            "counts": evidence.get("counts"),
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
    report = {
        "city": args.city,
        "line": args.line,
        "measure": measure,
        "kind": args.kind,
        "group": args.group,
        "end_date": end.isoformat(),
        "timings": timings,
    }
    args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
