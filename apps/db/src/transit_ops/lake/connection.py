"""Read-only lake sessions with an explicit server-capability fallback."""

from collections.abc import Callable
from typing import Any
from uuid import uuid4

import psycopg


def connect_lake(
    url: str, *, allow_no_connection_check: bool, log: Callable[[dict[str, object]], None]
) -> Any:
    options = (
        "-c statement_timeout=1000 -c lock_timeout=1000 "
        "-c default_transaction_read_only=on "
        "-c tcp_keepalives_idle=60 -c tcp_keepalives_interval=10 -c tcp_keepalives_count=3"
    )
    kwargs: dict[str, Any] = dict(
        autocommit=True,
        connect_timeout=5,
        application_name="transit-lake-migrate-" + uuid4().hex,
        keepalives=1,
        keepalives_idle=60,
    )
    try:
        return psycopg.connect(
            url, options=options + " -c client_connection_check_interval=1000", **kwargs
        )
    except psycopg.Error as error:
        if 'invalid value for parameter "client_connection_check_interval"' not in str(error):
            raise
        if error.sqlstate is None:
            # libpq omits SQLSTATE for startup failures. Obtain the server's
            # structured refusal in a probe; it performs no source reads.
            with psycopg.connect(url, options=options, **kwargs) as probe:
                try:
                    probe.execute(
                        "SELECT set_config('client_connection_check_interval', '1000', false)"
                    )
                except psycopg.Error as refusal:
                    if (
                        refusal.sqlstate != "22023"
                        or 'invalid value for parameter "client_connection_check_interval"'
                        not in str(refusal)
                    ):
                        raise
                else:
                    raise error
        elif error.sqlstate != "22023":
            raise
        if not allow_no_connection_check:
            raise ValueError("connection_check_unsupported") from error
        log({"client_connection_check": "unsupported_on_server"})
        return psycopg.connect(url, options=options, **kwargs)
