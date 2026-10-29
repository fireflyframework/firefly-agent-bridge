# Copyright (c) 2026 Signature Management Consultants SLU
# Modified by Firefly Software Foundation for Firefly Agent Bridge (2026).
# Author: @ancongui (https://github.com/ancongui)
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import asyncio
import os
import httpx2

from openai import AsyncOpenAI
from pydantic import BaseModel
from pydantic_ai import Agent, NativeOutput
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider


class Calculation(BaseModel):
    total: int
    explanation: str


async def main():
    # This key is a scoped ffb_ bridge token, never a provider credential.
    async with AsyncOpenAI(
        base_url=os.environ.get("BRIDGE_URL", "http://127.0.0.1:8766").rstrip("/") + "/v1",
        api_key=os.environ["BRIDGE_TOKEN"],
        max_retries=0,
        timeout=httpx2.Timeout(connect=5, read=None, write=30, pool=5),
    ) as client:
        capability = (await client.get("/bridge/status", cast_to=dict, options={"timeout": 5})).get("workDuration", {})
        if (type(capability.get("version")) is not int or capability.get("version") != 1
                or capability.get("protocol") != "firefly-bridge-work-duration-v1"
                or capability.get("nullableTimeout") is not True or capability.get("frozenAtAdmission") is not True):
            raise RuntimeError("This example requires Bridge work-duration version 1 support")
        model = OpenAIChatModel("bridge/default", provider=OpenAIProvider(openai_client=client))
        agent = Agent(model, output_type=NativeOutput(Calculation), model_settings={
            "extra_body": {"bridge": {"workDuration": {"version": 1, "timeoutMs": None}, "waitTimeoutMs": None}}
        })

        @agent.tool_plain
        def add(a: int, b: int) -> int:
            """Add integers in this Python process and return their sum."""
            return a + b

        result = await agent.run("Use add with a=2 and b=5. Return the total and a short explanation.")
        print(result.output.model_dump_json(indent=2))


if __name__ == "__main__":
    asyncio.run(main())
