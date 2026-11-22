import argparse
import json
import math
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path
from threading import Barrier
from time import perf_counter
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from transit_engine.server import BUSY_MESSAGE
from transit_engine.store import CITY


def measure_url(base: str, city: str, start: date, end: date) -> str:
    query = urlencode(
        {"measure": "punctuality", "city": city, "from": start.isoformat(), "to": end.isoformat()}
    )
    return f"{base.rstrip('/')}/measure?{query}"


def request(url: str) -> tuple[int, bool, dict[str, Any]]:
    http_request = Request(url)
    for name in ("CF-Access-Client-Id", "CF-Access-Client-Secret"):
        value = os.environ.get(name.upper().replace("-", "_"))
        if value:
            http_request.add_unredirected_header(name, value)
    try:
        response = urlopen(http_request, timeout=30)
    except HTTPError as error:
        response = error
    with response:
        return response.code, response.headers.get("X-Engine-Queued") == "true", json.load(response)


def health(base: str) -> dict[str, Any]:
    try:
        status, _, info = request(f"{base}/healthz")
        if status == 200 and isinstance(info, dict):
            return info
    except (OSError, ValueError):
        pass
    return {}


def main() -> None:
    parser = argparse.ArgumentParser(description="Burst distinct service-day queries at one engine")
    parser.add_argument("--url", required=True)
    parser.add_argument("--city", required=True)
    parser.add_argument("--end-date", type=date.fromisoformat, required=True)
    parser.add_argument("--requests", type=int, default=32)
    parser.add_argument("--memory-limit-mib", type=int, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    end: date = args.end_date
    size: int = args.requests
    if not CITY.fullmatch(args.city) or not 1 <= size <= min(end.toordinal(), 256):
        parser.error("provide a provider slug and 1 to 256 distinct service days")
    if args.memory_limit_mib < 1:
        parser.error("memory limit must be positive")
    base: str = args.url.rstrip("/")
    gate = Barrier(size)

    def ask(day: date) -> tuple[str, bool, float]:
        gate.wait(timeout=15)
        started = perf_counter()
        queued = False
        result = "errors"
        try:
            status, queued, body = request(measure_url(base, args.city, day, day))
            evidence = body.get("evidence", {})
            if status == 503 and body.get("message") == BUSY_MESSAGE:
                result = "busy"
            elif (
                status == 200
                and body.get("measure") == "punctuality"
                and evidence.get("city") == args.city
                and evidence.get("start_date") == evidence.get("end_date") == day.isoformat()
                and body.get("state")
            ):
                result = "answered"
        except (AttributeError, OSError, ValueError):
            pass
        return result, queued, (perf_counter() - started) * 1000

    before = health(base)
    with ThreadPoolExecutor(max_workers=size) as pool:
        results = list(pool.map(ask, (end - timedelta(days=i) for i in range(size))))
    after = health(base)
    latencies = sorted(latency for _, _, latency in results)
    counts = {
        key: sum(result == key for result, _, _ in results)
        for key in ("answered", "busy", "errors")
    }
    memory_limit_bytes = args.memory_limit_mib * 1024**2
    peak = after.get("peak_rss_bytes")
    same_process = bool(before.get("boot_id")) and before["boot_id"] == after.get("boot_id")
    passed = (
        counts["errors"] == 0
        and counts["answered"] > 0
        and same_process
        and isinstance(peak, int)
        and peak < memory_limit_bytes
    )
    report = {
        "passed": passed,
        "city": args.city,
        "start_date": (end - timedelta(days=size - 1)).isoformat(),
        "end_date": end.isoformat(),
        "requests": size,
        **counts,
        "queued": sum(queued for _, queued, _ in results),
        "latency_ms": {f"p{p}": latencies[math.ceil(size * p / 100) - 1] for p in (50, 95, 99)},
        "same_process": same_process,
        "peak_rss_bytes": peak,
        "memory_limit_bytes": memory_limit_bytes,
    }
    args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    if not passed:
        raise SystemExit(1)
