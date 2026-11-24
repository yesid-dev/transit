
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit

import pytest
from pydantic import ValidationError

from transit_ops.core.models import AuthConfig, AuthType, SignatureScheme
from transit_ops.ingestion.common import build_request_details
from transit_ops.settings import Settings


def test_env_value_resolves_declared_field() -> None:
    settings = Settings(_env_file=None, STM_API_KEY="declared-key")
    assert settings.env_value("STM_API_KEY") == "declared-key"


def test_env_value_unset_declared_field_is_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("STM_API_KEY", raising=False)
    settings = Settings(_env_file=None)
    assert settings.env_value("STM_API_KEY") is None


def test_env_value_undeclared_resolves_from_process_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("STO_PUBLIC_KEY", raising=False)
    settings = Settings(_env_file=None)
    assert settings.env_value("STO_PUBLIC_KEY") is None
    assert settings.env_value(None) is None

    monkeypatch.setenv("STO_PUBLIC_KEY", "pub-123")
    assert settings.env_value("STO_PUBLIC_KEY") == "pub-123"


def test_build_request_details_api_key_header() -> None:
    settings = Settings(_env_file=None, STM_API_KEY="secret")
    auth = AuthConfig(
        auth_type=AuthType.API_KEY,
        credential_env_var="STM_API_KEY",
        auth_header_name="apiKey",
    )
    details = build_request_details(
        source_url="https://api.example/feed", auth=auth, settings=settings
    )
    assert details.request_headers == {"apiKey": "secret"}
    assert details.request_url == "https://api.example/feed"


@pytest.mark.parametrize(
    ("scheme", "expected_hash"),
    [
        (
            "sha256_utc_minute",
            "87d41350b2b7477dd5ffe217e346a887aa07a438fc62dcff5e2b9b2aa4a78f2b",
        ),
        (
            "sha256_utc_minute_upper",
            "87D41350B2B7477DD5FFE217E346A887AA07A438FC62DCFF5E2B9B2AA4A78F2B",
        ),
    ],
)
def test_build_request_details_signed_appends_key_and_minute_hash(
    monkeypatch: pytest.MonkeyPatch,
    scheme: str,
    expected_hash: str,
) -> None:
    monkeypatch.setenv("FIXTURE_PUBLIC_KEY", "pub-key")
    monkeypatch.setenv("FIXTURE_PRIVATE_KEY", "fixture-secret")
    settings = Settings(_env_file=None)
    auth = AuthConfig(
        auth_type=AuthType.API_KEY_SIGNED,
        credential_env_var="FIXTURE_PUBLIC_KEY",
        auth_query_param="key",
        signing_secret_env_var="FIXTURE_PRIVATE_KEY",
        signature_query_param="hash",
        signature_scheme=SignatureScheme(scheme),
    )
    now = datetime(2026, 6, 19, 10, 30, 45, tzinfo=timezone(timedelta(hours=-4)))

    details = build_request_details(
        source_url="https://example.test/feed?file=tripupdates",
        auth=auth,
        settings=settings,
        now=now,
    )

    assert parse_qs(urlsplit(details.request_url).query) == {
        "file": ["tripupdates"],
        "key": ["pub-key"],
        "hash": [expected_hash],
    }
    assert details.request_headers == {}


def test_build_request_details_signed_requires_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("STO_PUBLIC_KEY", "pub-key")
    monkeypatch.delenv("STO_PRIVATE_KEY", raising=False)
    settings = Settings(_env_file=None)
    auth = AuthConfig(
        auth_type=AuthType.API_KEY_SIGNED,
        credential_env_var="STO_PUBLIC_KEY",
        auth_query_param="key",
        signing_secret_env_var="STO_PRIVATE_KEY",
        signature_query_param="hash",
        signature_scheme=SignatureScheme.SHA256_UTC_MINUTE,
    )
    with pytest.raises(ValueError, match="STO_PRIVATE_KEY"):
        build_request_details(source_url="https://x/y", auth=auth, settings=settings)


def test_auth_config_signed_requires_signature_fields() -> None:
    with pytest.raises(ValidationError):
        AuthConfig(
            auth_type=AuthType.API_KEY_SIGNED,
            credential_env_var="STO_PUBLIC_KEY",
            auth_query_param="key",
        )
