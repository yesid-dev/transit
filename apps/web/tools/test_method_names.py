"""Check the web names against the live registry implementation.

Run from the repository root with:
uv run --project apps/engine --locked python apps/web/tools/test_method_names.py
"""
import json
import unittest
from pathlib import Path

from transit_engine.measures import methods


class MethodNamesTest(unittest.TestCase):
    def test_each_registry_measure_has_an_english_and_french_name(self):
        path = Path(__file__).resolve().parents[1] / "src/lib/features/record/methodNames.json"
        names = json.loads(path.read_text(encoding="utf-8"))
        for entry in methods():
            measure = entry["id"]
            labels = names.get(measure, [])
            for index, locale in enumerate(("en", "fr")):
                with self.subTest(measure=measure, locale=locale):
                    self.assertGreater(len(labels), index, "Missing localized measure name")
                    self.assertIsInstance(labels[index], str)
                    self.assertTrue(labels[index].strip(), "Empty localized measure name")


if __name__ == "__main__":
    unittest.main()
