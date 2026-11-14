from types import SimpleNamespace

import parallel_db
import pytest
from sqlalchemy.engine import make_url


@pytest.fixture(autouse=True)
def disposable_environment(monkeypatch):
    for key in "PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGSERVICE PGSERVICEFILE".split():
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv(
        "TRANSIT_TEST_DATABASE_DISPOSABLE", "I_UNDERSTAND_THIS_DATABASE_IS_DISPOSABLE"
    )


@pytest.mark.parametrize("authority", ["127.0.0.1", "production.invalid"])
def test_connect_kwargs_preserve_effective_target_and_password(authority):
    url = make_url(
        f"postgresql+psycopg://transit_ci:fixture@{authority}:5432/transit_ci"
        + ("?host=127.0.0.1" if authority == "production.invalid" else "")
    )
    expected = dict(host="127.0.0.1", port="5432", user="transit_ci", dbname="transit_ci")
    assert parallel_db.guarded_connect_kwargs(url) == expected | {"password": "fixture"}


def test_connect_kwargs_refuse_non_disposable_target():
    url = make_url("postgresql+psycopg://transit_ci:fixture@127.0.0.1/transit_ci")
    with pytest.raises(RuntimeError, match="Disposable test database target policy failed"):
        parallel_db.guarded_connect_kwargs(url.update_query_dict({"host": "production.invalid"}))


@pytest.mark.parametrize("key", [None, "host", "hostaddr", "port", "dbname"])
def test_fixture_login_preserves_guarded_endpoint(key):
    base = make_url(
        "postgresql+psycopg://transit_ci:fixture@production.invalid:5432/transit_ci"
        "?host=127.0.0.1&hostaddr=127.0.0.1"
    )
    login = base.set(username="rescue_" + "a" * 32, password="temporary")
    if key:
        login = login.update_query_dict({key: "5433" if key == "port" else "127.0.0.2"})
        with pytest.raises(ValueError, match="endpoint"):
            parallel_db.guarded_login_kwargs(base, login)
    else:
        assert parallel_db.guarded_login_kwargs(base, login) == {
            "host": "127.0.0.1",
            "hostaddr": "127.0.0.1",
            "port": "5432",
            "dbname": "transit_ci",
            "user": "rescue_" + "a" * 32,
            "password": "temporary",
        }
        with pytest.raises(RuntimeError, match="Disposable test database target policy failed"):
            parallel_db.guarded_connect_kwargs(login)


def test_fixture_login_cannot_bypass_base_guard_or_allow_other_roles():
    base = make_url("postgresql+psycopg://transit_ci:fixture@127.0.0.1/transit_ci")
    with pytest.raises(ValueError, match="fixture-created rescue login"):
        parallel_db.guarded_login_kwargs(base, base.set(username="unapproved"))
    remote = base.set(host="production.invalid")
    with pytest.raises(RuntimeError, match="Disposable test database target policy failed"):
        parallel_db.guarded_login_kwargs(remote, remote.set(username="rescue_" + "a" * 32))


@pytest.mark.parametrize("rescue_login", [False, True])
def test_nested_connect_overrides_query_options_without_changing_target(monkeypatch, rescue_login):
    import test_measure_fact_day as m
    import test_rescue_fact_day as r

    base = make_url(
        "postgresql+psycopg://transit_ci:fixture@production.invalid:5432/transit_ci"
        "?host=127.0.0.1&application_name=custom&options=-c%20search_path%3Dpublic"
    )
    role = "rescue_" + "a" * 32 if rescue_login else "transit_ci"
    options = "-c statement_timeout=1000" if rescue_login else "-c search_path=public"
    monkeypatch.setattr(r.rescue.psycopg, "connect", lambda **kwargs: kwargs)

    def installed(owner, name, connect):
        actual = connect()
        target = tuple(actual[k] for k in ("host", "port", "dbname", "user"))
        assert target == ("127.0.0.1", "5432", "transit_ci", role)
        assert actual["application_name"].startswith("transit-ls04-rescue-")
        assert actual["autocommit"] is True
        assert actual["options"] == options
        raise StopIteration

    patch = SimpleNamespace(setattr=installed)
    login = base.set(username=role, password="temporary")
    extra = [None, patch, False, login] if rescue_login else [patch]
    callers = [m.measurement_db.__wrapped__, r.test_rescue_real_queued_lock_releases_only_source]
    with pytest.raises(StopIteration):
        callers[rescue_login](SimpleNamespace(url=base), (None, None, None), *extra)
