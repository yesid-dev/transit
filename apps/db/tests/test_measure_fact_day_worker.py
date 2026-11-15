import json

import pytest
from test_measure_fact_day import measure


@pytest.mark.parametrize(
    "source,value,message",
    [
        (
            "DATABASE_URL",
            "postgresql://user:ONLY_URL_SECRET@localhost/db",
            "rejected credential ONLY_URL_SECRET",
        ),
        (
            "DATABASE_URL",
            "postgresql://user:review%20url%20secret@localhost/db",
            "password='review url secret' host=localhost",
        ),
        ("PGPASSWORD", "review'quoted secret", None),
    ],
)
@pytest.mark.parametrize("channel", ["exception", "stderr"])
def test_worker_redacts_review_credential_reproductions(
    tmp_path, capsys, monkeypatch, source, value, message, channel
):
    from psycopg.conninfo import make_conninfo

    monkeypatch.delenv("PGPASSWORD", raising=False)
    monkeypatch.setenv(source, value)
    if message is None:
        message = make_conninfo(host="localhost", password=value)
    worker = "import sys; " + (
        f"raise RuntimeError({message!r})"
        if channel == "exception"
        else f"sys.stderr.write({message!r}); sys.stderr.flush(); raise SystemExit(7)"
    )
    assert measure.supervise([], worker=worker, scratch_root=tmp_path) != 0
    output = capsys.readouterr()
    result = json.loads(output.out)
    assert result["reason"] == (
        "measurement_failed" if channel == "exception" else "worker_crashed"
    )
    assert "<REDACTED>" in result["error_detail"]
    for fragment in ("ONLY_URL_SECRET", "url secret", "quoted secret", " secret'"):
        assert fragment not in output.out + output.err


def test_worker_stderr_never_persists_raw_secret(tmp_path, capsys, monkeypatch):
    secret = "REVIEW_SYNTHETIC_PGPASSWORD"
    monkeypatch.setenv("PGPASSWORD", secret)
    monkeypatch.setattr(measure.tempfile, "tempdir", str(tmp_path))
    temporary, popen = measure.tempfile.TemporaryFile, measure.Popen
    files, persisted = [], []

    def track_file(*args, **kwargs):
        stream = temporary(*args, **kwargs)
        files.append(stream)
        return stream

    def launch(*args, **kwargs):
        process = popen(*args, **kwargs)
        wait = process.wait

        def inspect_files(*a, **kw):
            result = wait(*a, **kw)
            for stream in files:
                if not stream.closed:
                    position = stream.tell()
                    stream.seek(0)
                    contents = stream.read()
                    stream.seek(position)
                    persisted.append(
                        secret in (contents.decode() if isinstance(contents, bytes) else contents)
                    )
            captured_paths = {str(stream.name) for stream in files}
            for path in tmp_path.rglob("*"):
                if path.is_file() and str(path) not in captured_paths:
                    persisted.append(secret.encode() in path.read_bytes())
            return result

        process.wait = inspect_files
        return process

    monkeypatch.setattr(measure.tempfile, "TemporaryFile", track_file)
    monkeypatch.setattr(measure, "Popen", launch)
    worker = (
        "import os,sys; sys.stderr.write(os.environ['PGPASSWORD']); sys.stderr.flush(); sys.exit(7)"
    )
    assert measure.supervise([], worker=worker, scratch_root=tmp_path) == 7
    result = json.loads(capsys.readouterr().out)
    assert result["reason"] == "worker_crashed"
    assert "<REDACTED>" in result["error_detail"]
    assert persisted and not any(persisted), "raw stderr credential was written to a temporary file"


@pytest.mark.parametrize(
    "source",
    [
        "PGPASSWORD",
        "DATABASE_URL",
        "BRONZE_S3_SECRET_KEY",
        "BRONZE_S3_ACCESS_KEY",
        "CUSTOM_PASSWORD",
        "CUSTOM_SECRET_VALUE",
        "CUSTOM_TOKEN",
        "CUSTOM_KEY",
    ],
)
@pytest.mark.parametrize("channel", ["exception", "stderr"])
def test_worker_redacts_all_credential_sources_and_representations(
    tmp_path, capsys, monkeypatch, source, channel
):
    from urllib.parse import quote, unquote

    from psycopg.conninfo import make_conninfo

    secret = 'representation\' quoted \\ secret "tail" café'
    monkeypatch.delenv("PGPASSWORD", raising=False)
    value = (
        f"postgresql://db_user:{quote(secret, safe='')}@localhost/db@archive"
        if source == "DATABASE_URL"
        else secret
    )
    monkeypatch.setenv(source, value)
    values = [secret]
    if source == "DATABASE_URL":
        userinfo = value.split("://")[1].split("@")[0]
        values += [userinfo, unquote(userinfo)]
    renderings = []
    for credential in values:
        renderings += [
            credential,
            quote(credential, safe=""),
            make_conninfo(password=credential).removeprefix("password="),
            json.dumps(credential)[1:-1],
            repr(credential)[1:-1],
        ]
    message = "formats: " + " | ".join(renderings)
    worker = "import sys; " + (
        f"raise RuntimeError({message!r})"
        if channel == "exception"
        else f"sys.stderr.write({message!r}); sys.stderr.flush(); raise SystemExit(7)"
    )
    assert measure.supervise([], worker=worker, scratch_root=tmp_path) != 0
    result = json.loads(capsys.readouterr().out)
    assert "formats: " + " | ".join(["<REDACTED>"] * len(renderings)) in result["error_detail"]


def test_worker_stderr_drops_truncated_credential_line_and_drains_large_output(
    tmp_path, capsys, monkeypatch
):
    monkeypatch.setenv("PGPASSWORD", "prefix" * 12 + "TAIL_CREDENTIAL_SUFFIX")
    worker = """import os,sys
sys.stderr.write('discarded noise' * 1000000 + '\\n')
secret=os.environ['PGPASSWORD']
sys.stderr.write(secret[:10]); sys.stderr.flush()
sys.stderr.write(secret[10:] + 'x' * (65536 - len(secret)//2) + '\\nfinal diagnostic\\n')
sys.stderr.flush()
sys.exit(7)
"""
    assert measure.supervise([], worker=worker, scratch_root=tmp_path) == 7
    result = json.loads(capsys.readouterr().out)
    assert result["reason"] == "worker_crashed"
    assert "TAIL_CREDENTIAL_SUFFIX" not in result["error_detail"]
    assert "final diagnostic" in result["error_detail"]
    assert len(result["error_detail"]) <= 2048


def test_worker_redacts_a_credential_split_across_stderr_reads(tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("PGPASSWORD", "SYNTHETIC_CHUNK_BOUNDARY_PASSWORD")
    worker = """import os,sys
secret=os.environ['PGPASSWORD'].encode()
sys.stderr.buffer.write(b'x' * (8192-10) + secret[:10]); sys.stderr.flush()
sys.stderr.buffer.write(secret[10:] + b'\\nfinal diagnostic\\n'); sys.stderr.flush()
sys.exit(7)
"""
    assert measure.supervise([], worker=worker, scratch_root=tmp_path) == 7
    result = json.loads(capsys.readouterr().out)
    assert "<REDACTED>" in result["error_detail"]
    assert "BOUNDARY_PASSWORD" not in result["error_detail"]


def test_worker_redacts_longest_value_first_and_preserves_short_values(
    tmp_path, capsys, monkeypatch
):
    monkeypatch.setenv("PGPASSWORD", "SYNTHETIC_LONG_SECRET")
    monkeypatch.setenv("CUSTOM_TOKEN", "SYNTHETIC_LONG")
    monkeypatch.setenv("CUSTOM_KEY", "abc")
    worker = "raise RuntimeError('SYNTHETIC_LONG_SECRET abc')"
    assert measure.supervise([], worker=worker, scratch_root=tmp_path) == 1
    result = json.loads(capsys.readouterr().out)
    assert result["error_detail"].endswith("RuntimeError: <REDACTED> abc")


def test_worker_stderr_never_exposes_a_truncated_multiline_credential(
    tmp_path, capsys, monkeypatch
):
    monkeypatch.setenv("PGPASSWORD", "prefix" * 16 + "\nTAIL_MULTILINE_PASSWORD")
    worker = """import os,sys
secret=os.environ['PGPASSWORD']
intro='\\nhttps://example.invalid/'
end='\\nfinal diagnostic\\n'
padding=65536-len(secret)+20-len(intro)-len(end)
sys.stderr.write(secret+intro+'x'*padding+end); sys.stderr.flush()
sys.exit(7)
"""
    assert measure.supervise([], worker=worker, scratch_root=tmp_path) == 7
    result = json.loads(capsys.readouterr().out)
    assert "TAIL_MULTILINE_PASSWORD" not in result["error_detail"]
    assert "final diagnostic" in result["error_detail"]


def test_worker_redacts_stderr_credentials_outside_the_system_code_page(
    tmp_path, capsys, monkeypatch
):
    monkeypatch.setenv("PGPASSWORD", "SYNTHETIC_🚎_CREDENTIAL")
    worker = (
        "import os,sys; sys.stderr.write(os.environ['PGPASSWORD']); sys.stderr.flush(); sys.exit(7)"
    )
    assert measure.supervise([], worker=worker, scratch_root=tmp_path) == 7
    result = json.loads(capsys.readouterr().out)
    assert "<REDACTED>" in result["error_detail"]
    assert "CREDENTIAL" not in result["error_detail"]
