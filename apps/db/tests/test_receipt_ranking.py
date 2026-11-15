import re
from datetime import date

import duckdb
from _sqlfakes import NamedQueryConn

from transit_ops.snapshots.builders.historic.small_surfaces import build_receipts
from transit_ops.sql_registry import query_name


class ReceiptConnection(NamedQueryConn):
    def __init__(self, database):
        super().__init__(
            {
                "receipts.accountability": [
                    dict(
                        provider_local_date=date(2026, 11, 10),
                        affected_route_count=1,
                        affected_stop_count=2,
                        alert_count=0,
                        rider_impact_score=1,
                    )
                ]
            }
        )
        self.database = database

    def execute(self, statement, params=None):
        name = query_name(statement)
        if name != "receipts.worst_stop":
            return super().execute(statement, params)
        sql = re.sub(r":(\w+)", r"$\1", str(statement))
        used = set(re.findall(r"\$(\w+)", sql))
        result = self.database.execute(sql, {k: v for k, v in params.items() if k in used})
        rows = [
            dict(zip([c[0] for c in result.description], row, strict=True))
            for row in result.fetchall()
        ]
        return NamedQueryConn({name: rows}).execute(statement, params)


def test_receipt_selects_the_eligible_runner_up_before_the_winner():
    with duckdb.connect() as database:
        database.execute("CREATE SCHEMA gold")
        database.execute("CREATE TABLE gold.dim_provider(provider_id VARCHAR)")
        database.execute("INSERT INTO gold.dim_provider VALUES ('test')")
        database.execute(
            "CREATE TABLE gold.public_stop_delay_daily("
            "provider_id VARCHAR, provider_local_date DATE, stop_id VARCHAR, "
            "avg_delay_seconds DOUBLE, max_delay_seconds DOUBLE, "
            "stop_time_observation_count BIGINT)"
        )
        database.execute(
            "INSERT INTO gold.public_stop_delay_daily VALUES "
            "('test','2026-11-10','closed',1200,1200,100),"
            "('test','2026-11-10','thin',900,900,29),"
            "('test','2026-11-10','eligible',100,100,30)"
        )
        receipts = build_receipts(
            ReceiptConnection(database),
            provider_id="test",
            generated_utc="2026-11-11T00:00:00Z",
            excluded_stops={"closed"},
        )
        assert receipts["2026-11-10"].worst_stop.id == "eligible"
