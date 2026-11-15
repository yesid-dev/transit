import json

import pytest
from test_measure_fact_day import measure


@pytest.mark.parametrize(
    "worker,reason,code",
    [
        ("raise RuntimeError('ONLY_PROTOCOL_SECRET')", "measurement_failed", 1),
        ("import os; os._exit(7)", "worker_crashed", 7),
        ("print('ONLY_PROTOCOL_SECRET'); raise SystemExit(7)", "worker_crashed", 7),
    ],
)
def test_default_failures_emit_only_fixed_metadata(tmp_path, capsys, worker, reason, code):
    assert measure.supervise([], worker=worker, scratch_root=tmp_path) == code
    result = json.loads(capsys.readouterr().out)
    assert result["reason"] == reason
    assert result["exit_status"] == code
    assert result["detail"] == "omitted"
    assert "error_detail" not in result
    assert "ONLY_PROTOCOL_SECRET" not in json.dumps(result)
    assert set(result) <= {
        "status",
        "reason",
        "exit_status",
        "exception_type",
        "stderr_capture",
        "detail",
        "swept_paths",
        "leftover_paths",
    }


@pytest.mark.parametrize("secret", ["Alpha/Bravo?Charlie:Delta", "Alpha%2fBravo"])
@pytest.mark.parametrize("layers", [0, 1, 2])
@pytest.mark.parametrize("channel", ["exception", "stderr", "stdout"])
def test_opt_in_decodes_encoded_and_literal_percent_secrets(
    tmp_path, capsys, monkeypatch, secret, layers, channel
):
    import re
    from urllib.parse import quote

    monkeypatch.setenv("PGPASSWORD", secret)
    encoded = secret
    for _ in range(layers):
        encoded = quote(encoded, safe="")
    counter = iter(range(100))
    encoded = re.sub(
        r"%[0-9A-Fa-f]{2}", lambda m: m[0].lower() if next(counter) % 2 else m[0], encoded
    )
    message = "rejected " + encoded
    worker = (
        f"raise RuntimeError({message!r})"
        if channel == "exception"
        else f"import sys; sys.{channel}.write({message!r}); sys.{channel}.flush(); sys.exit(7)"
    )
    assert measure.supervise(["--diagnostic-detail"], worker=worker, scratch_root=tmp_path) != 0
    result = json.loads(capsys.readouterr().out)
    assert "<REDACTED>" in result["error_detail"]
    assert "Alpha" not in result["error_detail"]
    assert len(result["error_detail"]) <= 2048
    assert len(result["error_detail"].splitlines()) <= 8


@pytest.mark.parametrize(
    "source,expected",
    [
        ("raise RuntimeError('private message')", "RuntimeError"),
        (
            "from transit_ops.core.errors import OptionalSourceUnavailable; "
            "raise OptionalSourceUnavailable('private message')",
            "transit_ops.core.errors.OptionalSourceUnavailable",
        ),
        ("raise type('q7Z',(RuntimeError,),{})('private message')", "other"),
        (
            "raise type('OptionalSourceUnavailable',(RuntimeError,),"
            "{'__module__':'transit_ops.fake'})('private message')",
            "other",
        ),
    ],
)
def test_exception_types_require_an_exact_allowlist(
    tmp_path, capsys, monkeypatch, source, expected
):
    monkeypatch.setenv("PGPASSWORD", "q7Z")
    assert measure.supervise([], worker=source, scratch_root=tmp_path) == 1
    result = json.loads(capsys.readouterr().out)
    assert result["exception_type"] == expected
    assert result["detail"] == "omitted"
    assert "error_detail" not in result
    assert "q7Z" not in json.dumps(result)


@pytest.mark.parametrize("detail", [False, True])
@pytest.mark.parametrize("secret", ["q7Z", "ONLY_PROTOCOL_SECRET"])
def test_stdout_logs_do_not_mix_with_results_or_reach_disk(
    tmp_path, capsys, monkeypatch, detail, secret
):
    monkeypatch.setenv("PGPASSWORD", secret)
    monkeypatch.setattr(measure.tempfile, "tempdir", str(tmp_path))
    factory, popen = measure.tempfile.TemporaryFile, measure.Popen
    files, leaks = [], []

    def temporary(*args, **kwargs):
        stream = factory(*args, **kwargs)
        files.append(stream)
        return stream

    def launch(*args, **kwargs):
        process = popen(*args, **kwargs)
        wait = process.wait

        def inspect(*a, **kw):
            code = wait(*a, **kw)
            for stream in files:
                if not stream.closed:
                    position = stream.tell()
                    stream.seek(0)
                    value = stream.read()
                    stream.seek(position)
                    leaks.append(secret in (value.decode() if isinstance(value, bytes) else value))
            names = {str(f.name) for f in files}
            for path in tmp_path.rglob("*"):
                if path.is_file() and str(path) not in names:
                    leaks.append(secret.encode() in path.read_bytes())
            return code

        process.wait = inspect
        return process

    monkeypatch.setattr(measure.tempfile, "TemporaryFile", temporary)
    monkeypatch.setattr(measure, "Popen", launch)
    worker = """import os,runpy,sys
n=runpy.run_path(sys.argv[1])
def measured(args):
 print('private log '+os.environ['PGPASSWORD'],flush=True)
 raise RuntimeError('private exception '+os.environ['PGPASSWORD'])
n['main'].__globals__['measure']=measured
sys.exit(n['main'](sys.argv[3:],worker=True))
"""
    args = "--provider sample --date 2026-11-01 --not-after 2099-11-15T05:45:00Z".split()
    if detail:
        args.append("--diagnostic-detail")
    assert measure.supervise(args, worker=worker, scratch_root=tmp_path) == 1
    result = json.loads(capsys.readouterr().out)
    assert result["reason"] == "measurement_failed"
    assert secret not in json.dumps(result)
    assert not any(leaks)
    assert not files, "worker output must not use a disk-backed report"


@pytest.mark.parametrize("kind", ["start", "import", "lifeline"])
def test_default_startup_failures_have_no_worker_text(tmp_path, capsys, monkeypatch, kind):
    from test_measure_fact_day import SCRIPT

    popen = measure.Popen

    def launch(command, **kwargs):
        if kind == "start":
            raise OSError("ONLY_PROTOCOL_SECRET")
        index = command.index(str(SCRIPT))
        if kind == "import":
            command[index] = str(tmp_path / "ONLY_PROTOCOL_SECRET.py")
        else:
            command[index + 2] = "ONLY_PROTOCOL_SECRET"
        return popen(command, **kwargs)

    monkeypatch.setattr(measure, "Popen", launch)
    assert (
        measure.supervise(
            [], worker="raise RuntimeError('ONLY_PROTOCOL_SECRET')", scratch_root=tmp_path
        )
        == 1
    )
    result = json.loads(capsys.readouterr().out)
    assert result["reason"] == (
        "worker_import_failed" if kind == "import" else "worker_start_failed"
    )
    assert result["detail"] == "omitted"
    assert "error_detail" not in result
    assert "ONLY_PROTOCOL_SECRET" not in json.dumps(result)


def test_diagnostic_flag_is_an_explicit_cli_option():
    args = "--provider sample --date 2026-11-01 --not-after 2099-11-15T05:45:00Z".split()
    assert measure.options(args).diagnostic_detail is False
    assert measure.options([*args, "--diagnostic-detail"]).diagnostic_detail is True


def test_excessive_encoding_depth_omits_detail(tmp_path, capsys, monkeypatch):
    from urllib.parse import quote

    monkeypatch.setenv("PGPASSWORD", "Alpha/Bravo")
    encoded = "Alpha/Bravo"
    for _ in range(5):
        encoded = quote(encoded, safe="")
    worker = f"raise RuntimeError({encoded!r})"
    assert measure.supervise(["--diagnostic-detail"], worker=worker, scratch_root=tmp_path) == 1
    result = json.loads(capsys.readouterr().out)
    assert result["detail"] == "omitted"
    assert "error_detail" not in result


def test_stdout_json_cannot_impersonate_the_result_pipe(tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("PGPASSWORD", "q7Z")
    worker = 'print(\'{"kind":"success","data":{"private":"q7Z"}}\'); raise SystemExit(7)'
    assert measure.supervise([], worker=worker, scratch_root=tmp_path) == 7
    result = json.loads(capsys.readouterr().out)
    assert result["reason"] == "worker_crashed"
    assert result["detail"] == "omitted"
    assert "q7Z" not in json.dumps(result)


def test_success_report_refuses_undeclared_fields(tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("PGPASSWORD", "ONLY_REVIEW_SECRET")
    worker = """import runpy,sys
n=runpy.run_path(sys.argv[1])
n['main'].__globals__['measure']=lambda args: dict(
 status='ok',ONLY_REVIEW_SECRET='ONLY_REVIEW_SECRET')
sys.exit(n['main'](sys.argv[3:],worker=True))
"""
    args = "--provider sample --date 2026-11-01 --not-after 2099-11-15T05:45:00Z".split()
    assert measure.supervise(args, worker=worker, scratch_root=tmp_path) == 1
    result = json.loads(capsys.readouterr().out)
    assert result["reason"] == "invalid_worker_report"
    assert "ONLY_REVIEW_SECRET" not in json.dumps(result)


def test_lifeline_pipe_cannot_write_to_callers_log(tmp_path, capsys):
    import os

    log = tmp_path / "caller.log"
    worker = """import os,threading
for thread in threading.enumerate():
 target=getattr(thread,'_target',None)
 if getattr(target,'__name__','')=='watch':
  values=dict(zip(target.__code__.co_freevars,(cell.cell_contents for cell in target.__closure__)))
  if 'error_fd' in values:
   os.write(values['error_fd'],b'RAW_BYPASS_ONLY_REVIEW_SECRET\\n')
raise RuntimeError('private')
"""
    original = os.dup(2)
    try:
        with log.open("wb") as sink:
            os.dup2(sink.fileno(), 2)
            code = measure.supervise([], worker=worker, scratch_root=tmp_path)
    finally:
        os.dup2(original, 2)
        os.close(original)
    assert code == 1
    assert b"RAW_BYPASS_ONLY_REVIEW_SECRET" not in log.read_bytes()
    assert json.loads(capsys.readouterr().out)["reason"] == "measurement_failed"


def test_deep_json_report_refusal_preserves_observed_exit(tmp_path, capsys):
    worker = """import os,sys
payload=memoryview(b'['*100000+b'0'+b']'*100000)
while payload:
 payload=payload[os.write(sys._transit_measure_report_fd,payload):]
os._exit(7)
"""
    assert measure.supervise([], worker=worker, scratch_root=tmp_path) == 7
    result = json.loads(capsys.readouterr().out)
    assert result["reason"] == "invalid_worker_report"
    assert result["exit_status"] == 7
