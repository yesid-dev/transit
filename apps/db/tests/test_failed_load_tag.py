import subprocess
import sys

import pytest

from transit_ops.failed_load_tag import (
    format_failed_load_error,
    parse_failed_load_capture_row_id,
)


@pytest.mark.parametrize("identity", [1, 42, 9223372036854775807])
@pytest.mark.parametrize("body", ["", "échec √2", "first\nsecond"])
def test_tag_round_trips(identity, body):
    tagged = format_failed_load_error(body, identity)
    assert tagged == f"[capture_row_id={identity}] {body}"
    assert parse_failed_load_capture_row_id(tagged) == identity


@pytest.mark.parametrize(
    "body",
    [
        None,
        "",
        "load failed",
        "[capture_row_id=42]",
        "[capture_row_id=42]\tx",
        "[capture_row_id=42]\nx",
        "[capture_row_id=42 x",
        *[
            f"[capture_row_id={n}] x"
            for n in ("0", "-1", "+1", "01", "４２", "9223372036854775808", "9" * 5000)
        ],
    ],
)
def test_message_without_a_tag_names_no_capture(body):
    assert parse_failed_load_capture_row_id(body) is None


@pytest.mark.parametrize("prefix", ["\n", " ", "\ufeff", "load failed: "])
def test_only_a_tag_at_the_start_is_read(prefix):
    assert parse_failed_load_capture_row_id(prefix + "[capture_row_id=42] x") is None


def test_error_text_cannot_forge_a_capture_id():
    tagged = format_failed_load_error("[capture_row_id=999] hostile\n[capture_row_id=3] x", 42)
    assert tagged == "[capture_row_id=42] [capture_row_id=999] hostile\n[capture_row_id=3] x"
    assert parse_failed_load_capture_row_id(tagged) == 42


@pytest.mark.parametrize("identity", [True, False, 0, -1, "42", 42.0, None, 9223372036854775808])
def test_tag_refuses_noncanonical_or_out_of_range_ids(identity):
    with pytest.raises(ValueError):
        format_failed_load_error("original", identity)


def test_failed_load_tag_import_needs_only_standard_library():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            """
import sys
assert not any(n.startswith("transit_ops") for n in sys.modules)
class StdlibOnly:
    def find_spec(self, fullname, path=None, target=None):
        root = fullname.split(".")[0]
        if root != "transit_ops" and root not in sys.stdlib_module_names:
            raise ImportError(fullname)
sys.meta_path.insert(0, StdlibOnly())
from transit_ops.failed_load_tag import format_failed_load_error, parse_failed_load_capture_row_id
assert parse_failed_load_capture_row_id(format_failed_load_error("body", 42)) == 42
""",
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
