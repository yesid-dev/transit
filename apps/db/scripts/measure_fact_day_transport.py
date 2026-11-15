"""Bounded, memory-only transport for the isolated measurement process."""

import os
import sys
import threading


class PipeCapture:
    def __init__(self, stream, limit=65536):
        self.stream, self.limit = stream, limit
        self.buffer = bytearray()
        self.truncated = False
        self.error = None
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.drain, daemon=True)
        self.thread.start()

    def drain(self):
        try:
            with self.stream:
                descriptor = self.stream.fileno()
                os.set_blocking(descriptor, False)
                while not self.stop.is_set():
                    try:
                        block = os.read(descriptor, 8192)
                    except BlockingIOError:
                        self.stop.wait(0.02)
                        continue
                    if not block:
                        break
                    self.buffer.extend(block)
                    if len(self.buffer) > self.limit:
                        del self.buffer[: -self.limit]
                        self.truncated = True
        except OSError as error:
            self.error = error

    def finish(self):
        self.thread.join(timeout=2)
        if self.thread.is_alive():
            self.stop.set()
            self.thread.join()
            return b"", False, "did_not_close"
        if self.error:
            return b"", False, "read_failed"
        return bytes(self.buffer), self.truncated, "complete"


def launch(factory, command, *, env):
    receipt_read, receipt_write = os.pipe()
    receipts = os.fdopen(receipt_read, "rb", buffering=0)
    read, write = os.pipe()
    stream = os.fdopen(read, "rb", buffering=0)
    try:
        descriptors = (receipt_write, write)
        if sys.platform == "win32":
            import msvcrt
            from subprocess import STARTUPINFO

            inherited = [msvcrt.get_osfhandle(fd) for fd in descriptors]
            for handle in inherited:
                os.set_handle_inheritable(handle, True)
            options = dict(
                startupinfo=STARTUPINFO(lpAttributeList={"handle_list": inherited}), close_fds=True
            )
        else:
            inherited = descriptors
            options = dict(pass_fds=descriptors)
        process = factory(
            command[:3] + [str(fd) for fd in inherited] + command[3:],
            stdin=-1,
            stdout=-1,
            stderr=-1,
            env=env,
            **options,
        )
        return process, stream, receipts
    except BaseException:
        stream.close()
        receipts.close()
        raise
    finally:
        os.close(receipt_write)
        os.close(write)


def receive_descriptor(value):
    descriptor = int(value)
    if sys.platform == "win32":
        import msvcrt

        descriptor = msvcrt.open_osfhandle(descriptor, os.O_WRONLY)
    os.set_inheritable(descriptor, False)
    return descriptor
