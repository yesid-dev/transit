import asyncio
import json
import logging
import os
import re
import sys
from datetime import date
from typing import Any, Literal, cast
from urllib.parse import parse_qs
from uuid import uuid4

import uvicorn
from uvicorn._types import ASGIReceiveCallable, ASGISendCallable, Scope

from transit_engine.health import data_health
from transit_engine.measures import EntityKind, Language, Question, answer_csv, ask, methods
from transit_engine.ranking import DEFAULT_LIMIT, Ranking, rank, ranking_csv
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
) -> None:
    csv_response = isinstance(payload, str)
    headers = [
        (b"content-type", b"text/csv; charset=utf-8" if csv_response else b"application/json"),
        (b"cache-control", b"no-store"),
        (b"x-engine-queued", b"true" if queued else b"false"),
    ]
    if status == 503:
        headers.append((b"retry-after", b"1"))
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
    optional = {"hour", "day_type", "format", "lang"}
    if ranking:
        required.add("kind")
        optional.update({"measure", "class", "limit"})
    else:
        required.add("measure")
        optional.update({"line", "direction", "stop", "departure"})
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
    for name in ("line", "stop"):
        if (value := params.get(name)) is not None and (
            not value.isprintable() or value != value.strip()
        ):
            raise ValueError(f"{name} must be a valid schedule ID")
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
    output = params.get("format", "json")
    language = params.get("lang", "en")
    if output not in ("json", "csv") or language not in ("en", "fr"):
        raise ValueError("format must be json or csv and lang must be en or fr")
    output_format: Literal["json", "csv"] = "csv" if output == "csv" else "json"
    output_language: Language = "fr" if language == "fr" else "en"
    question = Question(
        params.get("measure", "on_time"),
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
    )
    if ranking:
        kind = params["kind"]
        if kind not in ("line", "stop", "departure"):
            raise ValueError("kind must be line, stop or departure")
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
    def __init__(self, store: Store, concurrency: int, queue_size: int, queue_wait_ms: int):
        self.store = store
        self.slots = asyncio.BoundedSemaphore(concurrency)
        self.queue_size = queue_size
        self.queue_timeout = queue_wait_ms / 1000
        self.waiting = 0
        self.boot_id = uuid4().hex

    async def __call__(
        self, scope: Scope, receive: ASGIReceiveCallable, send: ASGISendCallable
    ) -> None:
        if scope["type"] != "http":
            raise RuntimeError("Only HTTP is supported")
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
        if scope["path"] not in {"/measure", "/ranking"}:
            await respond(send, 404, {"message": "not found"})
            return
        try:
            question, output, language = _question(
                scope["query_string"], ranking=scope["path"] == "/ranking"
            )
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
        def run_query() -> dict[str, Any] | str:
            if isinstance(question, Ranking):
                answer = rank(self.store, question)
                return ranking_csv(answer, language) if output == "csv" else answer
            answer = ask(self.store, question)
            return answer_csv(answer, language) if output == "csv" else answer

        query = asyncio.create_task(asyncio.to_thread(run_query))

        def finished(task: asyncio.Task[Any]) -> None:
            self.slots.release()
            if not task.cancelled():
                task.exception()

        query.add_done_callback(finished)
        try:
            answer = await asyncio.shield(query)
        except Exception as error:
            # DuckDB errors can include storage configuration. Log the class only.
            LOGGER.error("engine query failed (%s)", type(error).__name__)
            await respond(send, 500, {"message": "query failed"}, queued=queued)
        else:
            await respond(send, 200, answer, queued=queued)

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
            await respond(send, 200, answer, queued=queued)


def main() -> None:
    store = Store.from_env()
    app = Engine(
        store,
        concurrency=env_int("ENGINE_CONCURRENCY", 2),
        queue_size=env_int("ENGINE_QUEUE_SIZE", 16, minimum=0),
        queue_wait_ms=env_int("ENGINE_QUEUE_WAIT_MS", 5000),
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
