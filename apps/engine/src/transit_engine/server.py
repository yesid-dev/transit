import asyncio
import json
import logging
import os
import re
import sys
from datetime import date
from hmac import compare_digest
from pathlib import Path
from typing import Any, Literal, cast
from urllib.parse import parse_qs
from uuid import uuid4

import uvicorn
from uvicorn._types import ASGIReceiveCallable, ASGISendCallable, Scope

from transit_engine.health import data_health
from transit_engine.measures import (
    CORRIDOR_RANKING_DEFAULT,
    VEHICLE_RANKING_DEFAULT,
    EntityKind,
    Language,
    Question,
    answer_csv,
    ask,
    methods,
)
from transit_engine.ranking import DEFAULT_LIMIT, Ranking, rank, ranking_csv
from transit_engine.search import UnknownSearchCity, search_index
from transit_engine.series import SeriesGroup
from transit_engine.store import Store, env_int

BUSY_MESSAGE = "busy, try again"
LOGGER = logging.getLogger("uvicorn.error")


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
    queued: bool = False,
    cleaning_version: int | None = None,
    days_pending: int | None = None,
) -> None:
    csv_response = isinstance(payload, str)
    headers = [
        (b"content-type", b"text/csv; charset=utf-8" if csv_response else b"application/json"),
        (b"cache-control", b"no-store"),
        (b"x-engine-queued", b"true" if queued else b"false"),
    ]
    if status == 503:
        headers.append((b"retry-after", b"1"))
    if status == 401:
        headers.append((b"www-authenticate", b"Bearer"))
    if cleaning_version is not None:
        headers.append((b"x-transit-cleaning-version", str(cleaning_version).encode("ascii")))
    if days_pending is not None:
        headers.append((b"x-transit-days-pending", str(days_pending).encode("ascii")))
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
) -> tuple[Question | Ranking, Literal["json", "csv"], Language]:
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
    }
    if ranking:
        required.add("kind")
        optional.update({"measure", "class", "limit"})
    else:
        required.add("measure")
        optional.update({"stop", "departure", "vehicle", "group", "alert_details"})
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
    )
    if ranking:
        kind = params["kind"]
        if kind not in ("line", "stop", "departure", "vehicle", "segment"):
            raise ValueError("kind must be line, stop, departure, vehicle or segment")
        limit = params.get("limit", str(DEFAULT_LIMIT))
        if not re.fullmatch(r"[0-9]{1,3}", limit):
            raise ValueError("limit must be a positive integer")
        selection = Ranking(question, cast(EntityKind, kind), params.get("class"), int(limit))
        return selection, output_format, output_language
    return question, output_format, output_language


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
        self.slots = asyncio.BoundedSemaphore(concurrency)
        self.queue_size = queue_size
        self.queue_timeout = queue_wait_ms / 1000
        self.waiting = 0
        self.boot_id = uuid4().hex
        self.authorization = b"Bearer " + access_token if access_token else None

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
        if scope["path"] == "/healthz":
            await respond(send, 200, {"boot_id": self.boot_id, "peak_rss_bytes": peak_rss_bytes()})
            return
        if scope["path"] == "/how-we-measure":
            if scope["query_string"]:
                await respond(send, 400, {"message": "this endpoint takes no parameters"})
            else:
                await respond(send, 200, methods())
            return
        if scope["path"] == "/data-health":
            await self._data_health(scope["query_string"], send)
            return
        route = scope["path"]
        if route not in {"/measure", "/ranking", "/search-index"}:
            await respond(send, 404, {"message": "not found"})
            return
        try:
            question: Question | Ranking | str
            language: Language
            raw = scope["query_string"]
            if route == "/search-index":
                fields = parse_qs(raw.decode("ascii"), strict_parsing=True, max_num_fields=1)
                if set(fields) != {"city"}:
                    raise ValueError("provide city")
                question, output, language = fields["city"][0], "json", "en"
            else:
                question, output, language = _question(raw, ranking=route == "/ranking")
        except UnicodeError:
            await respond(send, 400, {"message": "invalid query encoding"})
            return
        except ValueError as error:
            await respond(send, 400, {"message": str(error)})
            return

        queued = self.slots.locked()
        if queued:
            if self.waiting >= self.queue_size:
                await respond(send, 503, {"message": BUSY_MESSAGE})
                return
            self.waiting += 1
            try:
                async with asyncio.timeout(self.queue_timeout):
                    await self.slots.acquire()
            except TimeoutError:
                await respond(send, 503, {"message": BUSY_MESSAGE}, queued=True)
                return
            finally:
                self.waiting -= 1
        else:
            await self.slots.acquire()

        # Keep the slot until DuckDB stops, including when a caller disconnects.
        def run_query() -> tuple[dict[str, Any] | str, int]:
            if isinstance(question, str):
                return search_index(self.store, question), 0
            if isinstance(question, Ranking):
                answer = rank(self.store, question)
                payload = ranking_csv(answer, language) if output == "csv" else answer
            else:
                answer = ask(self.store, question)
                payload = answer_csv(answer, language) if output == "csv" else answer
            return payload, len(answer["evidence"]["days_pending"])

        query = asyncio.create_task(asyncio.to_thread(run_query))

        def finished(task: asyncio.Task[Any]) -> None:
            self.slots.release()
            if not task.cancelled():
                task.exception()

        query.add_done_callback(finished)
        try:
            payload, days_pending = await asyncio.shield(query)
        except UnknownSearchCity as error:
            await respond(send, 400, {"message": str(error)}, queued=queued)
        except Exception as error:
            # DuckDB errors can include storage configuration. Log the class only.
            LOGGER.error("engine query failed (%s)", type(error).__name__)
            await respond(send, 500, {"message": "query failed"}, queued=queued)
        else:
            await respond(
                send,
                200,
                payload,
                queued=queued,
                cleaning_version=self.store.cleaning_version,
                days_pending=days_pending,
            )

    async def _data_health(self, raw: bytes, send: ASGISendCallable) -> None:
        try:
            city, start, end = _health(raw)
        except UnicodeError:
            await respond(send, 400, {"message": "invalid query encoding"})
            return
        except ValueError as error:
            await respond(send, 400, {"message": str(error)})
            return

        # Same admission as /measure, so health cannot bypass the overload limits.
        queued = self.slots.locked()
        if queued:
            if self.waiting >= self.queue_size:
                await respond(send, 503, {"message": BUSY_MESSAGE})
                return
            self.waiting += 1
            try:
                async with asyncio.timeout(self.queue_timeout):
                    await self.slots.acquire()
            except TimeoutError:
                await respond(send, 503, {"message": BUSY_MESSAGE}, queued=True)
                return
            finally:
                self.waiting -= 1
        else:
            await self.slots.acquire()

        work = asyncio.create_task(asyncio.to_thread(data_health, self.store, city, start, end))

        def finished(task: asyncio.Task[Any]) -> None:
            self.slots.release()
            if not task.cancelled():
                task.exception()

        work.add_done_callback(finished)
        try:
            answer = await asyncio.shield(work)
        except ValueError as error:
            await respond(send, 400, {"message": str(error)}, queued=queued)
        except Exception as error:
            LOGGER.error("data health failed (%s)", type(error).__name__)
            await respond(send, 500, {"message": "data health failed"}, queued=queued)
        else:
            days_pending = sum(
                day["status"] not in {"present", "not_measured"} for day in answer["days"]
            )
            await respond(
                send,
                200,
                answer,
                queued=queued,
                cleaning_version=self.store.cleaning_version,
                days_pending=days_pending,
            )


def main() -> None:
    store = Store.from_env()
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
