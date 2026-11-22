import asyncio
import json
import logging
import os
import sys
from datetime import date
from typing import Any
from urllib.parse import parse_qs
from uuid import uuid4

import uvicorn
from uvicorn._types import ASGIReceiveCallable, ASGISendCallable, Scope

from transit_engine.punctuality import CITY, Store, env_int, network_day

BUSY_MESSAGE = "busy, try again"
LOGGER = logging.getLogger("uvicorn.error")


def peak_rss_bytes() -> int | None:
    if sys.platform == "linux":
        from resource import RUSAGE_SELF, getrusage

        return int(getrusage(RUSAGE_SELF).ru_maxrss) * 1024
    return None


async def respond(
    send: ASGISendCallable, status: int, payload: dict[str, Any], *, queued: bool = False
) -> None:
    headers = [
        (b"content-type", b"application/json"),
        (b"cache-control", b"no-store"),
        (b"x-engine-queued", b"true" if queued else b"false"),
    ]
    if status == 503:
        headers.append((b"retry-after", b"1"))
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": json.dumps(payload).encode()})


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
        if scope["path"] != "/network-punctuality":
            await respond(send, 404, {"message": "not found"})
            return
        try:
            parameters = parse_qs(
                scope["query_string"].decode("ascii"), strict_parsing=True, max_num_fields=2
            )
            [city] = parameters["city"]
            [iso_day] = parameters["date"]
            day = date.fromisoformat(iso_day)
            if not CITY.fullmatch(city) or day.isoformat() != iso_day:
                raise ValueError
        except (KeyError, ValueError):
            await respond(send, 400, {"message": "provide a city and a YYYY-MM-DD service date"})
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
        query = asyncio.create_task(asyncio.to_thread(network_day, self.store, city, day))

        def finished(task: asyncio.Task[Any]) -> None:
            self.slots.release()
            if not task.cancelled():
                task.exception()

        query.add_done_callback(finished)
        try:
            answer = await asyncio.shield(query)
        except Exception as error:
            # DuckDB errors can include storage configuration. Log the class only.
            LOGGER.error("network punctuality query failed (%s)", type(error).__name__)
            await respond(send, 500, {"message": "query failed"}, queued=queued)
        else:
            await respond(send, 200, dict(answer), queued=queued)


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
