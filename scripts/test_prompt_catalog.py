# Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
# https://www.apache.org/licenses/LICENSE-2.0
"""Native authoring contracts; no provider, CLI or network execution."""

import json
import shutil
import tempfile
import unittest

import yaml
from pathlib import Path

from scripts.render_prompt_catalog import ROOT, generate


class NativePromptCatalogTests(unittest.TestCase):
    def test_ci_keeps_sdk_and_prompt_compiler_dependency_environments_separate(self):
        workflow = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())
        steps = workflow["jobs"]["native"]["steps"]
        sdk = next(step["run"] for step in steps if "tests/clients/requirements.txt" in step.get("run", ""))
        self.assertNotIn("scripts/prompts-requirements.txt", sdk)
        compiler = next(step["run"] for step in steps if "scripts/prompts-requirements.txt" in step.get("run", ""))
        self.assertIn("python -m venv", compiler)
        self.assertIn("RUNNER_TEMP", compiler)
        self.assertIn("BRIDGE_PROMPT_PYTHON", compiler)
        self.assertIn("Scripts/python.exe", compiler)
        self.assertIn("bin/python", compiler)
        self.assertIn("pydantic-ai-slim[openai]==2.49.0", (ROOT / "tests/clients/requirements.txt").read_text())

    def test_native_render_preserves_every_released_instruction(self):
        baseline = json.loads(
            (ROOT / "tests/fixtures/prompt-baseline.json").read_text()
        )
        actual = generate()
        self.assertEqual(
            {name: row["text"] for name, row in actual["prompts"].items()}, baseline
        )

    def test_malformed_or_dynamic_authoring_fails_before_native_rendering(self):
        transforms = {
            "duplicate_key": lambda text: text + "name: completion/system\n",
            "unknown_field": lambda text: text + "unexpected: true\n",
            "unknown_variable": lambda text: text.replace(
                "  You are the inference", "  {{ unknown }} You are the inference"
            ),
            "declared_runtime_variable": lambda text: text.replace(
                "required_variables: []", "required_variables: [input]"
            ),
            "wrong_version": lambda text: text.replace(
                "version: 1.0.0", "version: 2.0.0"
            ),
            "wrong_identity": lambda text: text.replace(
                "name: completion/system", "name: completion/other"
            ),
            "unused_output": lambda text: text.replace(
                'user_template: ""', 'user_template: "unexpected"'
            ),
        }
        for name, transform in transforms.items():
            with (
                self.subTest(name=name),
                tempfile.TemporaryDirectory(
                    prefix="bridge-native-prompts-"
                ) as directory,
            ):
                root = Path(directory)
                shutil.copytree(ROOT / "resources", root / "resources")
                path = root / "resources/prompts/v1/completion/system.yaml"
                before = path.read_text()
                after = transform(before)
                self.assertNotEqual(before, after)
                path.write_text(after)
                with self.assertRaises(ValueError):
                    generate(root)


if __name__ == "__main__":
    unittest.main()
