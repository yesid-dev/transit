import argparse
import json
import os
import platform
from datetime import date, timedelta
from pathlib import Path
from time import perf_counter
from typing import Any

import duckdb

from transit_engine.punctuality import BANDS, CITY, SCHEDULED_EVENTS, Store, network_day

# Match the three network questions and repeat count in the laptop Parquet benchmark.
PERIOD = "network: three bands for the period"
NETWORK_QUERIES = {
    PERIOD: f"SELECT {BANDS} {SCHEDULED_EVENTS}",
    "network: on-time share per day (trend)": f"""
        SELECT s.service_date, {BANDS} {SCHEDULED_EVENTS}
        GROUP BY s.service_date ORDER BY s.service_date
    """,
    "network: hour by weekday grid": f"""
        SELECT isodow(s.service_date) AS dow,
          date_diff('hour', s.service_date::TIMESTAMP,
            timezone($7, coalesce(s.scheduled_departure_utc, s.scheduled_arrival_utc))) AS hour,
          {BANDS} {SCHEDULED_EVENTS}
        GROUP BY ALL ORDER BY 1, 2
    """,
}


def main() -> None:
    parser = argparse.ArgumentParser(description="Time network queries over real clean days")
    parser.add_argument("--city", required=True)
    parser.add_argument("--end-date", type=date.fromisoformat, required=True)
    parser.add_argument("--spans", type=int, nargs="+", default=[1, 7, 30, 182, 365])
    parser.add_argument("--timezone", default="America/Toronto")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    city: str = args.city
    end: date = args.end_date
    spans: list[int] = sorted(set(args.spans))
    if not CITY.fullmatch(city) or not all(
        1 <= span <= min(end.toordinal(), 365) for span in spans
    ):
        parser.error("provide a provider slug and spans of 1 to 365 available calendar days")
    store = Store.from_env()
    report: dict[str, Any] = {
        "city": city,
        "end_date": end.isoformat(),
        "timezone": args.timezone,
        "duckdb": duckdb.__version__,
        "platform": platform.platform(),
        "cpu_count": os.cpu_count(),
        "storage": "s3" if store.s3_endpoint else "local",
        "threads": store.threads,
        "memory_mib": store.memory_mib,
        "cleaning_version": store.cleaning_version,
    }
    timings: list[dict[str, Any]] = []
    report["timings"] = timings
    failed = False
    try:
        # Includes opening DuckDB and discovering files, just as the HTTP service does.
        report["network_day"] = [network_day(store, city, end) for _ in range(3)]
        with store.connect() as conn:
            started = perf_counter()
            days = [end - timedelta(days=i) for i in range(max(spans))]
            days.reverse()
            resolved = [(day, store.files(conn, city, day)) for day in days]
            report["discovery_seconds"] = perf_counter() - started
            for span in spans:
                selected = resolved[-span:]
                start = selected[0][0]
                window = {
                    "days": span,
                    "start_date": start.isoformat(),
                    "end_date": end.isoformat(),
                }
                missing = [day.isoformat() for day, files in selected if files is None]
                if missing:
                    timings.append({**window, "missing_dates": missing})
                    failed = True
                    continue
                pairs = [files for _, files in selected if files is not None]
                stops, trips = map(list, zip(*pairs, strict=True))
                parameters = [stops, trips, city, str(store.cleaning_version), start, end]
                for question, sql in NETWORK_QUERIES.items():
                    entry = {**window, "query": question}
                    timings.append(entry)
                    if question.endswith("grid"):
                        query_parameters = [*parameters, args.timezone]
                    else:
                        query_parameters = parameters
                    seconds = []
                    try:
                        for _ in range(3):
                            started = perf_counter()
                            rows = conn.execute(sql, query_parameters).fetchall()
                            seconds.append(perf_counter() - started)
                    except duckdb.Error as error:
                        entry["error"] = type(error).__name__
                        failed = True
                    else:
                        entry.update(
                            {"first_s": seconds[0], "best_s": min(seconds), "runs_s": seconds}
                        )
                        if question == PERIOD:
                            entry["counts"] = dict(
                                zip(
                                    (
                                        "scheduled",
                                        "classified",
                                        "early",
                                        "on_time",
                                        "late",
                                        "not_measured_route_without_live_data",
                                        "not_measured_capture_gap",
                                    ),
                                    rows[0],
                                    strict=True,
                                )
                            )
    except (duckdb.Error, OSError) as error:
        report["error"] = type(error).__name__
        failed = True
    args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    if failed:
        raise SystemExit(1)
