from pathlib import Path


def test_web_fixture_equals_the_publisher_fixture():
    tests = Path(__file__).resolve().parent
    publisher = tests / "fixtures" / "ranking_vectors.json"
    web = tests.parents[1] / "web/src/lib/v1/ranking/__fixtures__/ranking_vectors.json"
    assert publisher.read_bytes() == web.read_bytes()
