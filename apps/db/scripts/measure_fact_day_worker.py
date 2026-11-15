"""Standard-library-only bootstrap and bounded diagnostics for the isolated worker."""

import json
import os
import re
import runpy
import sys
import traceback


def safe_detail(text: str) -> str:
    # Redact before truncation, including credentials split across the tail boundary.
    for key, value in os.environ.items():
        if value and any(
            part in key.upper() for part in ("PASSWORD", "SECRET", "TOKEN", "KEY", "URL")
        ):
            text = text.replace(value, "<REDACTED>")
    text = re.sub(r"[a-zA-Z][a-zA-Z0-9+.-]*://[^\s'\"]+", "<REDACTED_URL>", text)
    text = re.sub(
        r"(?i)\b(password|passwd|token|secret|access_key|api_key)\s*[=:]\s*[^\s,;]+",
        r"\1=<REDACTED>",
        text,
    )
    # Pydantic errors can include arbitrary settings input; omit that payload.
    text = re.sub(r"input_value=.*", "input_value=<REDACTED>", text)
    return "\n".join(text.splitlines()[-8:])[-2048:]


def failure(reason: str, error: BaseException) -> dict:
    detail = "".join(traceback.format_exception_only(type(error), error))
    return dict(status="failed", reason=reason, error_detail=safe_detail(detail))


def launch(factory, command, *, report, errors, env):
    # Keep the parent's diagnostic stream for lifeline loss, independently of capture.
    original = os.dup(2)
    try:
        if sys.platform == "win32":
            import msvcrt
            from subprocess import STARTUPINFO

            handle = msvcrt.get_osfhandle(original)
            os.set_handle_inheritable(handle, True)
            startup = STARTUPINFO(lpAttributeList={"handle_list": [handle]})
            options = dict(startupinfo=startup, close_fds=True)
            descriptor = handle
        else:
            options = dict(pass_fds=(original,))
            descriptor = original
        return factory(
            command[:3] + [str(descriptor)] + command[3:],
            stdin=-1,
            stdout=report,
            stderr=errors,
            env=env,
            **options,
        )
    finally:
        os.close(original)


def boot() -> int:
    reason = "worker_import_failed"
    descriptor = int(sys.argv.pop(1))
    if sys.platform == "win32":
        import msvcrt

        descriptor = msvcrt.open_osfhandle(descriptor, os.O_WRONLY)
    original_stderr = descriptor
    try:
        namespace = runpy.run_path(sys.argv[1])
        code = sys.argv.pop(4)
        proof = sys.argv.pop(3)
        reason = "worker_start_failed"
        namespace["lifeline"](sys.argv[2], proof, error_fd=original_stderr)
        reason = "measurement_failed"
        exec(code, {"__name__": "__main__"})
    except SystemExit:
        raise
    except BaseException as error:
        print(json.dumps(failure(reason, error)), flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(boot())
