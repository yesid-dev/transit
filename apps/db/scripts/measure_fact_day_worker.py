"""Standard-library-only bootstrap and bounded diagnostics for the isolated worker."""

import json
import locale
import os
import re
import runpy
import sys
import threading
import traceback
from urllib.parse import quote, quote_plus, unquote, urlsplit


def credential_forms() -> list[str]:
    values = set()
    for key, value in os.environ.items():
        if value and (
            key.upper() == "PGPASSWORD"
            or re.search(r"(?:^|_)(?:PASSWORD$|SECRET|TOKEN$|KEY$|URL$)", key.upper())
        ):
            values.add(value)
    url = os.environ.get("DATABASE_URL", "")
    try:
        authority = urlsplit(url).netloc
    except ValueError:
        authority = re.split(r"[/?#]", url.partition("://")[2], maxsplit=1)[0]
    userinfo = authority.rpartition("@")[0]
    if userinfo:
        values.update((userinfo, unquote(userinfo)))
        if ":" in userinfo:
            password = userinfo.split(":", 1)[1]
            values.update((password, unquote(password)))
    forms = set()
    for value in values:
        if len(value) < 4:
            continue
        encoded = {quote(value), quote(value, safe=""), quote_plus(value, safe="")}
        forms.update(encoded)
        forms.update(re.sub(r"%[0-9A-F]{2}", lambda m: m[0].lower(), v) for v in encoded)
        conninfo = value.replace("\\", "\\\\").replace("'", "\\'")
        for rendered in (value, conninfo, "'" + conninfo + "'"):
            forms.update((rendered, repr(rendered)[1:-1]))
            forms.update(json.dumps(rendered, ensure_ascii=ascii)[1:-1] for ascii in (True, False))
    return sorted(forms, key=len, reverse=True)


def safe_detail(text: str) -> str:
    # Replace complete values before field patterns and before output truncation.
    for value in credential_forms():
        text = text.replace(value, "<REDACTED>")
    text = re.sub(r"[a-zA-Z][a-zA-Z0-9+.-]*://[^\s'\"]+", "<REDACTED_URL>", text)
    text = re.sub(
        r"(?i)\b(password|passwd|token|secret|access_key|api_key)\s*[=:]\s*"
        r"(?:'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"|[^\s,;]+)",
        r"\1=<REDACTED>",
        text,
    )
    # Pydantic errors can include arbitrary settings input; omit that payload.
    text = re.sub(r"input_value=.*", "input_value=<REDACTED>", text)
    return "\n".join(text.splitlines()[-8:])[-2048:]


def failure(reason: str, error: BaseException) -> dict:
    detail = "".join(traceback.format_exception_only(type(error), error))
    return dict(status="failed", reason=reason, error_detail=safe_detail(detail))


def credential_byte_forms() -> list[bytes]:
    # Windows' isolated Python may use the system code page for redirected stderr.
    # Replace credentials as bytes before a lossy UTF-8 decode can change them.
    forms = set()
    for value in credential_forms():
        for encoding in {"utf-8", locale.getencoding()}:
            forms.add(value.encode(encoding, errors="backslashreplace"))
    return sorted(forms, key=len, reverse=True)


def safe_stderr(data: bytes, *, truncated: bool = False) -> str:
    forms = credential_byte_forms()
    if truncated:
        # A cut credential may span several lines. Drop its maximum possible suffix,
        # extending the boundary past any complete credential it would otherwise split.
        cut = min(len(data), max(map(len, forms), default=0))
        while cut < len(data):
            end = cut
            for value in forms:
                start = data.rfind(value, max(0, cut - len(value) + 1), cut + len(value) - 1)
                if start >= 0:
                    end = max(end, start + len(value))
            if end == cut:
                break
            cut = end
        data = data[cut:]
    for value in forms:
        data = data.replace(value, b"<REDACTED>")
    if truncated:
        data = data.partition(b"\n")[2]
    return safe_detail(data.decode("utf-8", errors="replace"))


class StderrTail:
    """Drain the pipe without ever persisting raw diagnostics or retaining unlimited input."""

    def __init__(self, stream):
        self.stream = stream
        self.buffer = bytearray()
        self.truncated = False
        self.error = None
        self.thread = threading.Thread(target=self.drain, daemon=True)
        self.thread.start()

    def drain(self):
        try:
            with self.stream:
                while block := self.stream.read(8192):
                    self.buffer.extend(block)
                    if len(self.buffer) > 65536:
                        del self.buffer[:-65536]
                        self.truncated = True
        except OSError as error:
            self.error = error

    def finish(self) -> str:
        self.thread.join(timeout=2)
        if self.thread.is_alive():
            raise OSError("worker_stderr_did_not_close")
        if self.error:
            raise self.error
        data = bytes(self.buffer)
        return safe_stderr(data, truncated=self.truncated)


def launch(factory, command, *, report, env):
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
            stderr=-1,
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
