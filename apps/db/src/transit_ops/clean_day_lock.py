"""Serialize clean-day builds across hosts using the destination bucket."""

from collections.abc import Iterator
from contextlib import contextmanager
from uuid import uuid4

from botocore.exceptions import ClientError

from transit_ops.ingestion.storage import BronzeStorage, S3BronzeStorage


@contextmanager
def claim_clean_day(storage: BronzeStorage, version: str) -> Iterator[bool]:
    if not isinstance(storage, S3BronzeStorage):
        yield True
        return

    key = f"locks/clean-days/{version}"
    address = {"Bucket": storage.bucket, "Key": key}
    try:
        current = storage.client.head_object(**address)
    except ClientError as error:
        if error.response["ResponseMetadata"]["HTTPStatusCode"] != 404:
            raise
        condition = {"IfNoneMatch": "*"}
    else:
        state = current["Metadata"]["state"]
        if state == "held":
            yield False
            return
        if state != "open":
            raise ValueError(f"Unexpected clean-day lock state: {key}")
        condition = {"IfMatch": current["ETag"]}

    try:
        acquired = storage.client.put_object(
            **address, **condition, Body=uuid4().hex.encode(), Metadata={"state": "held"}
        )
    except ClientError as error:
        if error.response["ResponseMetadata"]["HTTPStatusCode"] != 412:
            raise
        yield False
        return

    try:
        yield True
    finally:
        # Each write gets a different ETag. A late retry must never release a
        # different owner's lock or acquire against an earlier open version.
        storage.client.put_object(
            **address,
            IfMatch=acquired["ETag"],
            Body=uuid4().hex.encode(),
            Metadata={"state": "open"},
        )
