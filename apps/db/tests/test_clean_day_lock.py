from datetime import UTC, datetime, timedelta
from email.utils import format_datetime

import boto3
import pytest
from botocore.stub import ANY, Stubber

from transit_ops.clean_day_lock import claim_clean_day
from transit_ops.ingestion.storage import S3BronzeStorage

PROVIDER_DAY = "example/2026-06-01"
ADDRESS = {"Bucket": "clean", "Key": f"locks/clean-days/{PROVIDER_DAY}"}
SERVER_TIME = datetime(2026, 6, 2, 12, tzinfo=UTC)


@pytest.mark.parametrize(
    ("age", "claim_conflict", "release_conflict", "expected"),
    [
        (timedelta(hours=3) - timedelta(seconds=1), False, False, False),
        (timedelta(hours=3), False, False, True),
        (timedelta(hours=4), True, False, False),
        (timedelta(hours=4), False, True, True),
    ],
    ids=["fresh", "expired", "lost-takeover", "expired-before-release"],
)
def test_held_lease_uses_server_age_and_conditional_takeover(
    age: timedelta,
    claim_conflict: bool,
    release_conflict: bool,
    expected: bool,
    caplog: pytest.LogCaptureFixture,
) -> None:
    endpoint = "https://example.invalid"
    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name="auto",
        aws_access_key_id="test",
        aws_secret_access_key="test",
    )
    storage = S3BronzeStorage("s3", "clean", endpoint, client)
    with Stubber(client) as stub:
        stub.add_response(
            "head_object",
            {
                "ETag": '"old"',
                "Metadata": {"state": "held"},
                "LastModified": SERVER_TIME - age,
                "ResponseMetadata": {
                    "HTTPHeaders": {"date": format_datetime(SERVER_TIME, usegmt=True)}
                },
            },
            ADDRESS,
        )
        claim = {**ADDRESS, "IfMatch": '"old"', "Body": ANY, "Metadata": {"state": "held"}}
        release = {**ADDRESS, "IfMatch": '"new"', "Body": ANY, "Metadata": {"state": "open"}}
        if claim_conflict:
            stub.add_client_error(
                "put_object", "PreconditionFailed", http_status_code=412, expected_params=claim
            )
        elif expected:
            stub.add_response("put_object", {"ETag": '"new"'}, claim)
            if release_conflict:
                stub.add_client_error(
                    "put_object",
                    "PreconditionFailed",
                    http_status_code=412,
                    expected_params=release,
                )
            else:
                stub.add_response("put_object", {"ETag": '"open"'}, release)

        with claim_clean_day(storage, PROVIDER_DAY) as acquired:
            assert acquired is expected
        stub.assert_no_pending_responses()
    assert ("Taking over expired clean-day lock" in caplog.text) is expected
