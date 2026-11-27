"""Coordinate clean-day builds across hosts using a lease in the destination bucket."""

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import timedelta
from email.utils import parsedate_to_datetime
from typing import TYPE_CHECKING, cast
from uuid import uuid4

from botocore.exceptions import ClientError

from transit_ops.ingestion.storage import BronzeStorage, S3BronzeStorage

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client
    from mypy_boto3_s3.type_defs import PutObjectRequestTypeDef

_LEASE_DURATION = timedelta(hours=3)
_LOGGER = logging.getLogger(__name__)


@contextmanager
def claim_clean_day(storage: BronzeStorage, provider_day: str) -> Iterator[bool]:
    if not isinstance(storage, S3BronzeStorage):
        yield True
        return

    key = f"locks/clean-days/{provider_day}"
    client = cast("S3Client", storage.client)
    claim: PutObjectRequestTypeDef = {
        "Bucket": storage.bucket,
        "Key": key,
        "Body": uuid4().hex.encode(),
        "Metadata": {"state": "held"},
    }
    takeover = False
    try:
        current = client.head_object(Bucket=storage.bucket, Key=key)
    except ClientError as error:
        if error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") != 404:
            raise
        claim["IfNoneMatch"] = "*"
    else:
        state = current["Metadata"]["state"]
        if state == "held":
            # Compare two server timestamps so a runner's clock cannot expire a lease early.
            server_time = parsedate_to_datetime(current["ResponseMetadata"]["HTTPHeaders"]["date"])
            if server_time - current["LastModified"] < _LEASE_DURATION:
                yield False
                return
            takeover = True
        elif state != "open":
            raise ValueError(f"Unexpected clean-day lock state: {key}")
        claim["IfMatch"] = current["ETag"]

    try:
        acquired = client.put_object(**claim)
    except ClientError as error:
        if error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") != 412:
            raise
        yield False
        return

    try:
        if takeover:
            # A worker can outlive its lease. Create-only publication protects
            # the new owner's data files and manifest from being overwritten.
            _LOGGER.warning("Taking over expired clean-day lock for %s", provider_day)
        yield True
    finally:
        # Each write gets a different ETag. A late retry must never release a
        # different owner's lock or acquire against an earlier open version.
        try:
            client.put_object(
                Bucket=storage.bucket,
                Key=key,
                IfMatch=acquired["ETag"],
                Body=uuid4().hex.encode(),
                Metadata={"state": "open"},
            )
        except ClientError as error:
            if error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") != 412:
                raise
