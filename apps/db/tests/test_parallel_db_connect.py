import parallel_db
import pytest
from sqlalchemy.engine import make_url


@pytest.fixture(autouse=True)
def disposable_environment(monkeypatch):
    for key in (
        "PGHOST",
        "PGHOSTADDR",
        "PGPORT",
        "PGDATABASE",
        "PGUSER",
        "PGSERVICE",
        "PGSERVICEFILE",
    ):
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
    assert parallel_db.guarded_connect_kwargs(url) == {
        "host": "127.0.0.1",
        "port": "5432",
        "user": "transit_ci",
        "dbname": "transit_ci",
        "password": "fixture",
    }


def test_connect_kwargs_refuse_non_disposable_target():
    url = make_url("postgresql+psycopg://transit_ci:fixture@127.0.0.1/transit_ci")
    with pytest.raises(RuntimeError, match="Disposable test database target policy failed"):
        parallel_db.guarded_connect_kwargs(url.update_query_dict({"host": "production.invalid"}))


@pytest.mark.parametrize(
    "changed",
    [
        {},
        {"host": "other.invalid"},
        {"hostaddr": "127.0.0.2"},
        {"port": "5433"},
        {"dbname": "other"},
    ],
)
def test_fixture_login_preserves_guarded_endpoint(changed):
    base = make_url(
        "postgresql+psycopg://transit_ci:fixture@production.invalid:5432/transit_ci"
        "?host=127.0.0.1&hostaddr=127.0.0.1"
    )
    login = base.set(username="rescue_" + "a" * 32, password="temporary").update_query_dict(changed)
    if changed:
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
