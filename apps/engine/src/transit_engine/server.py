import asyncio
import json
import logging
import os
import re
import sys
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta
from hmac import compare_digest
from pathlib import Path
from time import monotonic
from typing import Any, Literal, cast
from urllib.parse import parse_qs
from uuid import uuid4

import uvicorn
from uvicorn._types import ASGIReceiveCallable, ASGISendCallable, HTTPScope, Scope

from transit_engine.cancellation import QueryCancellation, check_query, current_query
from transit_engine.cities import (
    ANSWER_REVISION,
    UnknownCity,
    city_catalog,
    public_declaration,
    service_zone,
)
from transit_engine.health import data_health
from transit_engine.measures import (
    _ALERT_COUNTS_ID,
    _SELECTIONS,
    CORRIDOR_RANKING_DEFAULT,
    VEHICLE_RANKING_DEFAULT,
    EntityKind,
    Language,
    NetworkCorridorsUnavailable,
    Question,
    answer_csv,
    ask,
    methods,
)
from transit_engine.partials import PartialResults
from transit_engine.ranking import DEFAULT_LIMIT, Ranking, rank, ranking_csv
from transit_engine.search import schedule_index, search_index
from transit_engine.series import SeriesGroup
from transit_engine.store import Store, env_int

BUSY_MESSAGE = "busy, try again"
SCHEDULE_ROUTES = {"/search-index", "/schedule-index", "/schedule-map"}
LOGGER = logging.getLogger("uvicorn.error")


@dataclass(frozen=True)
class QueryTiming:
    queued: bool
    queue_ms: float
    started: float | None = None

    def header(self) -> bytes:
        metrics = f"queue;dur={self.queue_ms:.2f}"
        if self.started is not None:
            metrics += f", engine;dur={(monotonic() - self.started) * 1000:.2f}"
        return metrics.encode("ascii")


def peak_rss_bytes() -> int | None:
    if sys.platform == "linux":
        from resource import RUSAGE_SELF, getrusage

        return int(getrusage(RUSAGE_SELF).ru_maxrss) * 1024
    return None


async def respond(
    send: ASGISendCallable,
    status: int,
    payload: dict[str, Any] | list[dict[str, Any]] | str,
    *,
    timing: QueryTiming | None = None,
    cleaning_version: int | None = None,
    days_pending: int | None = None,
) -> None:
    csv_response = isinstance(payload, str)
    headers = [
        (b"content-type", b"text/csv; charset=utf-8" if csv_response else b"application/json"),
        (b"cache-control", b"no-store"),
        (b"x-engine-queued", b"true" if timing and timing.queued else b"false"),
        (b"x-transit-answer-revision", ANSWER_REVISION.encode("ascii")),
    ]
    if status == 503:
        headers.append((b"retry-after", b"1"))
    if status == 401:
        headers.append((b"www-authenticate", b"Bearer"))
    if cleaning_version is not None:
        headers.append((b"x-transit-cleaning-version", str(cleaning_version).encode("ascii")))
    if days_pending is not None:
        headers.append((b"x-transit-days-pending", str(days_pending).encode("ascii")))
    if timing is not None:
        headers.append((b"server-timing", timing.header()))
    await send({"type": "http.response.start", "status": status, "headers": headers})
    body = payload if isinstance(payload, str) else json.dumps(payload)
    await send({"type": "http.response.body", "body": body.encode()})


def _date(value: str) -> date:
    parsed = date.fromisoformat(value)
    if parsed.isoformat() != value:
        raise ValueError("dates must be YYYY-MM-DD")
    return parsed


def _question(
    raw: bytes, *, ranking: bool = False
) -> tuple[Question | Ranking, Literal["json", "csv"], Language, bool]:
    required = {"city", "from", "to"}
    optional = {
        "line",
        "direction",
        "from_stop",
        "to_stop",
        "hour",
        "day_type",
        "effect",
        "cause",
        "format",
        "lang",
        "include_method",
    }
    if ranking:
        required.add("kind")
        optional.update({"measure", "class", "limit"})
    else:
        required.add("measure")
        optional.update({
            "stop", "departure", "vehicle", "group", "alert_details", "view", "include_overall"
        })
    if len(raw) > 4096 or re.search(rb"%(?![a-fA-F0-9]{2})", raw):
        raise ValueError("invalid query string")
    fields = parse_qs(
        raw.decode("ascii"),
        keep_blank_values=True,
        strict_parsing=True,
        errors="strict",
        max_num_fields=len(required | optional),
    )
    if not required <= fields.keys() <= required | optional or any(
        len(values) != 1 or not values[0] for values in fields.values()
    ):
        raise ValueError(f"provide {', '.join(sorted(required))} and use each parameter once")
    params = {name: values[0] for name, values in fields.items()}
    for name in ("line", "stop", "from_stop", "to_stop"):
        if (value := params.get(name)) is not None and (
            not value.isprintable() or value != value.strip()
        ):
            raise ValueError(f"{name} must be a valid schedule ID")
    for name in ("effect", "cause"):
        if (value := params.get(name)) is not None and (
            not value.isprintable() or value != value.strip()
        ):
            raise ValueError(f"{name} must be a published alert value")
    vehicle = params.get("vehicle")
    if vehicle is not None and (not vehicle.isprintable() or vehicle != vehicle.strip()):
        raise ValueError("vehicle must be a valid vehicle ID")
    direction = params.get("direction")
    if direction is not None and direction not in {"0", "1"}:
        raise ValueError("direction must be 0 or 1")
    hour = params.get("hour")
    if hour is not None and not re.fullmatch(r"[01]?[0-9]|2[0-3]", hour):
        raise ValueError("hour must be from 0 to 23")
    day_type = params.get("day_type")
    if day_type is not None and day_type not in {"weekday", "saturday", "sunday"}:
        raise ValueError("day_type must be weekday, saturday or sunday")
    departure = params.get("departure")
    if departure is not None and not re.fullmatch(r"[0-9]{2,6}:[0-5][0-9]:[0-5][0-9]", departure):
        raise ValueError("departure must be a GTFS service time (HH:MM:SS)")
    if "alert_details" in params and params["alert_details"] != "1":
        raise ValueError("alert_details must be 1")
    output = params.get("format", "json")
    language = params.get("lang", "en")
    if output not in ("json", "csv") or language not in ("en", "fr"):
        raise ValueError("format must be json or csv and lang must be en or fr")
    include_method = params.get("include_method", "1")
    if include_method not in ("0", "1") or (output == "csv" and include_method == "0"):
        raise ValueError("include_method=0 requires JSON")
    if "view" in params and (params["view"] != "map" or output != "json"):
        raise ValueError("view=map requires JSON")
    if "include_overall" in params and (params["include_overall"] != "1" or output != "json"):
        raise ValueError("include_overall=1 requires JSON")
    output_format: Literal["json", "csv"] = "csv" if output == "csv" else "json"
    output_language: Language = "fr" if language == "fr" else "en"
    question = Question(
        params.get(
            "measure",
            {
                "segment": CORRIDOR_RANKING_DEFAULT,
                "vehicle": VEHICLE_RANKING_DEFAULT,
            }.get(params.get("kind", ""), "on_time"),
        ),
        params["city"],
        _date(params["from"]),
        _date(params["to"]),
        params.get("line"),
        int(direction) if direction is not None else None,
        params.get("stop"),
        departure,
        int(hour) if hour is not None else None,
        day_type,
        ranking=ranking,
        effect=params.get("effect"),
        cause=params.get("cause"),
        vehicle=vehicle,
        group=cast(SeriesGroup | None, params.get("group")),
        from_stop=params.get("from_stop"),
        to_stop=params.get("to_stop"),
        alert_details="alert_details" in params,
        map_view=params.get("view") == "map",
        include_overall="include_overall" in params,
    )
    if ranking:
        kind = params["kind"]
        if kind not in ("line", "stop", "departure", "vehicle", "segment"):
            raise ValueError("kind must be line, stop, departure, vehicle or segment")
        limit = params.get("limit", str(DEFAULT_LIMIT))
        if not re.fullmatch(r"[0-9]{1,3}", limit):
            raise ValueError("limit must be a positive integer")
        selection = Ranking(question, cast(EntityKind, kind), params.get("class"), int(limit))
        return selection, output_format, output_language, include_method == "1"
    return question, output_format, output_language, include_method == "1"


def omit_method_text(answer: dict[str, Any]) -> None:
    for entry in answer.get("info", ()):
        entry.pop("text", None)
        entry.pop("csv_columns", None)
    if "overall" in answer:
        omit_method_text(answer["overall"])


def _health(raw: bytes) -> tuple[str, date, date]:
    required = {"city", "from", "to"}
    if len(raw) > 4096 or re.search(rb"%(?![a-fA-F0-9]{2})", raw):
        raise ValueError("invalid query string")
    fields = parse_qs(
        raw.decode("ascii"),
        keep_blank_values=True,
        strict_parsing=True,
        errors="strict",
        max_num_fields=len(required),
    )
    if fields.keys() != required or any(
        len(values) != 1 or not values[0] for values in fields.values()
    ):
        raise ValueError("provide city, from and to, and use each parameter once")
    params = {name: values[0] for name, values in fields.items()}
    return params["city"], _date(params["from"]), _date(params["to"])


class QueryLane:
    def __init__(self, concurrency: int, queue_size: int, queue_timeout: float):
        self.slots = asyncio.BoundedSemaphore(concurrency)
        self.queue_size = queue_size
        self.queue_timeout = queue_timeout
        self.waiting = 0

    async def admit(self, send: ASGISendCallable) -> QueryTiming | None:
        arrived = monotonic()
        if not self.slots.locked():
            await self.slots.acquire()
            return QueryTiming(False, 0, monotonic())
        if self.waiting >= self.queue_size:
            await respond(send, 503, {"message": BUSY_MESSAGE}, timing=QueryTiming(False, 0))
            return None
        self.waiting += 1
        try:
            async with asyncio.timeout(self.queue_timeout):
                await self.slots.acquire()
        except TimeoutError:
            await respond(
                send, 503, {"message": BUSY_MESSAGE},
                timing=QueryTiming(True, (monotonic() - arrived) * 1000),
            )
            return None
        finally:
            self.waiting -= 1
        started = monotonic()
        return QueryTiming(True, (started - arrived) * 1000, started)

    def release_when_done(self, task: asyncio.Task[Any]) -> None:
        self.slots.release()
        if not task.cancelled():
            task.exception()


async def disconnected(receive: ASGIReceiveCallable) -> None:
    while (await receive())["type"] != "http.disconnect":
        pass


class Engine:
    def __init__(
        self,
        store: Store,
        concurrency: int,
        queue_size: int,
        queue_wait_ms: int,
        *,
        access_token: bytes | None = None,
    ):
        self.store = store
        self.record = QueryLane(concurrency, queue_size, queue_wait_ms / 1000)
        self.catalogue = QueryLane(1, min(queue_size, 4), queue_wait_ms / 1000)
        self.quick = QueryLane(1, min(queue_size, 4), queue_wait_ms / 1000)
        self.small_store = replace(store, threads=1, memory_mib=min(store.memory_mib, 256))
        self.boot_id = uuid4().hex
        self.authorization = b"Bearer " + access_token if access_token else None

        self._cities_lock = asyncio.Lock()
        self._cities: dict[str, Any] | None = None
        self._cities_refresh_at = 0.0
        self._mirror_stamp: int | None = None

    def _load_cities(self) -> dict[str, Any]:
        stamp = None
        if not self.store.s3_endpoint:
            try:
                stamp = self.store.mirror_stamp().stat().st_mtime_ns
            except FileNotFoundError:
                pass
        if (
            self._cities is None
            or stamp != self._mirror_stamp
            or (stamp is None and monotonic() >= self._cities_refresh_at)
        ):
            catalog = city_catalog()
            for provider in catalog["providers"]:
                provider["record_through"] = self.store.record_through(provider["id"])
            catalog["cleaning_version"] = self.store.cleaning_version
            self._cities = catalog
            self._mirror_stamp = stamp
            # Direct stores without a mirror publisher refresh on the catalog's open TTL.
            self._cities_refresh_at = monotonic() + 30
        return self._cities

    async def __call__(
        self, scope: Scope, receive: ASGIReceiveCallable, send: ASGISendCallable
    ) -> None:
        if scope["type"] != "http":
            raise RuntimeError("Only HTTP is supported")
        if self.authorization is not None:
            provided = [value for name, value in scope["headers"] if name == b"authorization"]
            if len(provided) != 1 or not compare_digest(provided[0], self.authorization):
                await respond(send, 401, {"message": "Unauthorized"})
                return
        if scope["method"] != "GET":
            await respond(send, 405, {"message": "use GET"})
            return
        if scope["path"] in SCHEDULE_ROUTES | {"/measure", "/ranking", "/data-health", "/cities"}:
            cancellation = QueryCancellation()
            token = current_query.set(cancellation)
            try:
                request = asyncio.create_task(self._get(scope, send))
            finally:
                current_query.reset(token)
            gone = asyncio.create_task(disconnected(receive))
            try:
                await asyncio.wait((request, gone), return_when=asyncio.FIRST_COMPLETED)
                if request.done():
                    await request
                else:
                    await gone
            finally:
                if not request.done():
                    cancellation.stop()
                    request.cancel()
                gone.cancel()
                await asyncio.gather(request, gone, return_exceptions=True)
            return
        await self._get(scope, send)

    async def _get(self, scope: HTTPScope, send: ASGISendCallable) -> None:
        if scope["path"] == "/healthz":
            await respond(send, 200, {"boot_id": self.boot_id, "peak_rss_bytes": peak_rss_bytes()})
            return
        if scope["path"] == "/cities":
            if scope["query_string"]:
                await respond(send, 400, {"message": "this endpoint takes no parameters"})
            else:
                async with self._cities_lock:
                    catalog = await asyncio.to_thread(self._load_cities)
                await respond(send, 200, catalog, cleaning_version=self.store.cleaning_version)
            return
        if scope["path"] == "/how-we-measure":
            if scope["query_string"]:
                await respond(send, 400, {"message": "this endpoint takes no parameters"})
            else:
                await respond(send, 200, methods(), cleaning_version=self.store.cleaning_version)
            return
        require_public_city = (b"x-transit-require-public-city", b"1") in scope["headers"]
        if scope["path"] == "/data-health":
            await self._data_health(scope["query_string"], send)
            return
        route = scope["path"]
        if route not in SCHEDULE_ROUTES | {"/measure", "/ranking"}:
            await respond(send, 404, {"message": "not found"})
            return
        try:
            question: Question | Ranking | str
            language: Language
            include_method = True
            raw = scope["query_string"]
            lines = None
            if route in SCHEDULE_ROUTES:
                scoped_map = route == "/schedule-map"
                if scoped_map and (len(raw) > 4096 or re.search(rb"%(?![a-fA-F0-9]{2})", raw)):
                    raise ValueError("invalid query encoding or length")
                fields = parse_qs(
                    raw.decode("ascii"),
                    strict_parsing=True,
                    max_num_fields=2 if scoped_map else 1,
                    keep_blank_values=scoped_map,
                    errors="strict" if scoped_map else "replace",
                )
                if "city" not in fields or any(len(values) != 1 for values in fields.values()):
                    raise ValueError("provide city")
                if set(fields) - ({"city", "lines"} if scoped_map else {"city"}):
                    raise ValueError("unknown parameter")
                if "lines" in fields:
                    ids = json.loads(fields["lines"][0])
                    if not isinstance(ids, list) or not 1 <= len(ids) <= 256 or not all(
                        isinstance(line, str)
                        and 1 <= len(line) <= 256
                        and line.isprintable()
                        and line == line.strip()
                        for line in ids
                    ):
                        raise ValueError("provide 1 to 256 valid line IDs")
                    lines = set(ids)
                question, output, language = fields["city"][0], "json", "en"
            else:
                question, output, language, include_method = _question(
                    raw, ranking=route == "/ranking"
                )
                if require_public_city:
                    selection = question.question if isinstance(question, Ranking) else question
                    await asyncio.to_thread(public_declaration, selection.city)
        except UnicodeError:
            await respond(send, 400, {"message": "invalid query encoding"})
            return
        except ValueError as error:
            await respond(send, 400, {"message": str(error)})
            return

        lane = self.record
        if isinstance(question, str):
            lane = self.catalogue
        elif (
            isinstance(question, Question)
            and output == "json"
            and (question.end - question.start).days < 31
            and _SELECTIONS[question.measure][0].id == _ALERT_COUNTS_ID
        ):
            # Alert questions read the compact advisory history. Long exports
            # and rankings can read additional data and stay on the record lane.
            lane = self.quick
        timing = await lane.admit(send)
        if timing is None:
            return

        # Keep the slot until DuckDB stops, including when a caller disconnects.
        def run_query() -> tuple[dict[str, Any] | str, int]:
            check_query()
            if isinstance(question, str):
                if route in {"/schedule-index", "/schedule-map"}:
                    _, identity, _ = public_declaration(question)
                    today = datetime.now(UTC).astimezone(service_zone(identity)).date()
                    schedule = schedule_index(
                        self.small_store, question, today - timedelta(days=1),
                        index="maps" if route == "/schedule-map" else "search",
                    )
                    if schedule is not None and lines is not None:
                        shapes = schedule["route_shapes"]
                        schedule["route_shapes"] = {
                            line: shapes[line] for line in sorted(lines) if line in shapes
                        }
                    return {"schedule": schedule}, 0
                return search_index(self.small_store, question), 0
            if isinstance(question, Ranking):
                answer = rank(self.store, question, with_reference=output == "json")
                answer["excluded_count"] = len(answer["excluded"])
                answer["excluded"] = answer["excluded"][: question.limit]
                payload = ranking_csv(answer, language) if output == "csv" else answer
            else:
                answer = ask(self.small_store if lane is self.quick else self.store, question)
                payload = answer_csv(answer, language) if output == "csv" else answer
            if not include_method:
                omit_method_text(answer)
                if "reference" in answer:
                    omit_method_text(answer["reference"])
            return payload, len(answer["evidence"]["days_pending"])

        query = asyncio.create_task(asyncio.to_thread(run_query))

        query.add_done_callback(lane.release_when_done)
        try:
            payload, days_pending = await asyncio.shield(query)
        except UnknownCity as error:
            await respond(send, 400, {"message": str(error)}, timing=timing)
        except NetworkCorridorsUnavailable as error:
            await respond(send, 409, {"reason": error.reason, "message": str(error)}, timing=timing)
        except Exception as error:
            # DuckDB errors can include storage configuration. Log the class only.
            LOGGER.error("engine query failed (%s)", type(error).__name__)
            await respond(send, 500, {"message": "query failed"}, timing=timing)
        else:
            await respond(
                send,
                200,
                payload,
                timing=timing,
                cleaning_version=self.store.cleaning_version,
                days_pending=days_pending,
            )

    async def _data_health(self, raw: bytes, send: ASGISendCallable) -> None:
        try:
            city, start, end = _health(raw)
            # A private city has no answer, whoever asks, like /measure and /ranking.
            await asyncio.to_thread(public_declaration, city)
        except UnicodeError:
            await respond(send, 400, {"message": "invalid query encoding"})
            return
        except ValueError as error:
            await respond(send, 400, {"message": str(error)})
            return

        # Same admission as /measure, so health cannot bypass the overload limits.
        timing = await self.record.admit(send)
        if timing is None:
            return

        work = asyncio.create_task(asyncio.to_thread(data_health, self.store, city, start, end))
        work.add_done_callback(self.record.release_when_done)
        try:
            answer = await asyncio.shield(work)
        except ValueError as error:
            await respond(send, 400, {"message": str(error)}, timing=timing)
        except Exception as error:
            LOGGER.error("data health failed (%s)", type(error).__name__)
            await respond(send, 500, {"message": "data health failed"}, timing=timing)
        else:
            days_pending = sum(
                day["status"] not in {"present", "not_measured"} for day in answer["days"]
            )
            await respond(
                send,
                200,
                answer,
                timing=timing,
                cleaning_version=self.store.cleaning_version,
                days_pending=days_pending,
            )


def main() -> None:
    store = Store.from_env()
    if not store.s3_endpoint:
        store = replace(store, partial_results=PartialResults())
    token_file = os.environ.get("ENGINE_ACCESS_TOKEN_FILE")
    access_token = None
    if token_file is not None:
        access_token = Path(token_file).read_bytes().rstrip(b"\r\n")
        if not re.fullmatch(rb"[!-~]+", access_token):
            raise ValueError("ENGINE_ACCESS_TOKEN_FILE must hold one nonempty bearer token")
    app = Engine(
        store,
        concurrency=env_int("ENGINE_CONCURRENCY", 2),
        queue_size=env_int("ENGINE_QUEUE_SIZE", 16, minimum=0),
        queue_wait_ms=env_int("ENGINE_QUEUE_WAIT_MS", 5000),
        access_token=access_token,
    )
    uvicorn.run(
        app,
        host=os.environ.get("ENGINE_HOST", "127.0.0.1"),
        port=env_int("ENGINE_PORT", 8080),
        workers=1,
        lifespan="off",
        ws="none",
        backlog=128,
        timeout_keep_alive=2,
        access_log=False,
    )
