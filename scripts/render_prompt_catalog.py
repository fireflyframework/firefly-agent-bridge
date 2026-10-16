# Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
# https://www.apache.org/licenses/LICENSE-2.0
"""Compile maintained native Agentic templates into the Node-only catalog."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path

import yaml
from fireflyframework_agentic.prompts import PromptLoader, PromptRegistry
from jinja2 import Environment, meta

ROOT = Path(__file__).resolve().parents[1]
VERSION = "26.10.1"
FIELDS = {
    "name",
    "version",
    "description",
    "required_variables",
    "system_template",
    "user_template",
    "metadata",
}


class UniqueLoader(yaml.SafeLoader):
    """Reject duplicate keys before the native loader consumes the same file."""


def mapping(loader, node):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=True)
        if not isinstance(key, str) or key in result:
            raise ValueError("Prompt YAML keys must be unique strings")
        result[key] = loader.construct_object(value_node, deep=True)
    return result


UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)


def canonical(value):
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode()


def generate(root: Path = ROOT):
    if importlib.metadata.version("fireflyframework-agentic") != VERSION:
        raise ValueError(
            "Prompt rendering requires the pinned Agentic version " + VERSION
        )
    registry = PromptRegistry()
    prompts = {}
    directory = root / "resources/prompts"
    files = sorted((directory / "v1").rglob("*.yaml"))
    if not 1 <= len(files) <= 128:
        raise ValueError("Expected a bounded native prompt catalog")
    for path in files:
        raw = path.read_bytes()
        if (
            path.is_symlink()
            or not path.resolve().is_relative_to(directory.resolve())
            or len(raw) > 32768
        ):
            raise ValueError("Invalid prompt resource path or size")
        data = yaml.load(raw, Loader=UniqueLoader)
        if not isinstance(data, dict) or set(data) != FIELDS:
            raise ValueError("Unexpected native prompt fields")
        name = path.relative_to(directory / "v1").with_suffix("").as_posix()
        if data["name"] != name or data["version"] != "1.0.0" or name in prompts:
            raise ValueError("Invalid or duplicate prompt identity/version")
        if data["required_variables"] != [] or not isinstance(data["description"], str):
            raise ValueError("The embedded catalog accepts static templates only")
        if data["metadata"] not in ({"field": "system"}, {"field": "user"}):
            raise ValueError("Declare exactly one native output field")
        field = data["metadata"]["field"]
        for key in ("system_template", "user_template"):
            text = data[key]
            if not isinstance(text, str) or meta.find_undeclared_variables(
                Environment().parse(text)
            ):
                raise ValueError("Embedded prompts cannot have runtime Jinja variables")
            if "{{" in text or "{%" in text or "{#" in text:
                raise ValueError(
                    "Dynamic Jinja belongs in the Python factory, not the Node static catalog"
                )
            if key != field + "_template" and text:
                raise ValueError("Unused native output field must be empty")
        template = PromptLoader.from_file(path)
        registry.register(template)
        rendered = registry.get(name, version="1.0.0").render()
        text = getattr(rendered, field)
        if not isinstance(text, str) or not text or text != data[field + "_template"]:
            raise ValueError("Unexpected native static rendering")
        if path.read_bytes() != raw:
            raise ValueError("Prompt source changed while rendering")
        prompts[name] = {
            "version": "1.0.0",
            "field": field,
            "source": path.relative_to(root).as_posix(),
            "source_sha256": hashlib.sha256(raw).hexdigest(),
            "text_sha256": hashlib.sha256(text.encode()).hexdigest(),
            "text": text,
        }
    body = {
        "format": 1,
        "renderer": "fireflyframework-agentic@" + VERSION,
        "prompts": prompts,
    }
    return {**body, "catalog_sha256": hashlib.sha256(canonical(body)).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail if maintained YAML and generated catalog differ",
    )
    args = parser.parse_args()
    data = json.dumps(generate(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    target = ROOT / "resources/prompts/catalog.json"
    if args.check:
        if not target.is_file() or target.read_text() != data:
            raise SystemExit(
                "Prompt catalog is stale; render it with the pinned Agentic build environment"
            )
    else:
        target.write_text(data)
    print(
        "Verified native Agentic prompt catalog"
        if args.check
        else "Rendered native Agentic prompt catalog"
    )


if __name__ == "__main__":
    main()
