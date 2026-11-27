"""Bounded, disposable per-process cache for completed daily query results."""

import pickle
import zlib
from collections import OrderedDict
from collections.abc import Callable
from threading import Lock
from typing import cast

from transit_engine.cancellation import check_query

type PartialKey = tuple[str | None, ...]


class PartialResults:
    def __init__(self, max_bytes: int = 32 * 1024 * 1024, max_entries: int = 2048) -> None:
        self._max_bytes = max_bytes
        self._max_entries = max_entries
        self._data: OrderedDict[PartialKey, bytes] = OrderedDict()
        self._bytes = 0
        self._lock = Lock()

    def read_or_compute[T](self, key: PartialKey, compute: Callable[[], T]) -> T:
        check_query()
        with self._lock:
            payload = self._data.get(key)
            if payload is not None:
                self._data.move_to_end(key)
        if payload is not None:
            # These bytes only come from pickle.dumps in this process. Loading a
            # fresh object also keeps answer assembly from mutating cached results.
            return cast(T, pickle.loads(zlib.decompress(payload)))
        result = compute()
        check_query()
        payload = zlib.compress(pickle.dumps(result, protocol=pickle.HIGHEST_PROTOCOL), level=1)
        if len(payload) > self._max_bytes:
            return result
        with self._lock:
            previous = self._data.pop(key, b"")
            self._data[key] = payload
            self._bytes += len(payload) - len(previous)
            while self._bytes > self._max_bytes or len(self._data) > self._max_entries:
                _, oldest = self._data.popitem(last=False)
                self._bytes -= len(oldest)
        return result
