/*!
 * Copyright (c) 2026 Signature Management Consultants SLU
 * Author: @ancongui (https://github.com/ancongui)
 * Modified by Firefly Software Foundation for Firefly Agent Bridge (2026).
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { bridgePrompt } from "./prompt-catalog.js";
import { z } from "zod";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { BridgeError, type Job } from "./contracts.js";
import { decodeImage, IMAGE_LIMITS, type InputImage } from "./images.js";
const name = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const schema = z.record(z.string(), z.unknown());
const text = z.union([
  z.string(),
  z
    .array(
      z.union([
        z.strictObject({ type: z.literal("text"), text: z.string() }),
        z.strictObject({
          type: z.literal("image_url"),
          image_url: z.strictObject({
            url: z.string(),
            detail: z.literal("auto").optional(),
          }),
        }),
      ]),
    )
    .min(1),
]);
const call = z.strictObject({
  id: z.string().min(1).max(200),
  type: z.literal("function"),
  function: z.strictObject({ name, arguments: z.string() }),
});
export const chatRequestSchema = z.strictObject({
  model: z.string().regex(/^bridge\/[a-zA-Z0-9_-]{1,64}$/),
  messages: z
    .array(
      z.strictObject({
        role: z.enum(["system", "developer", "user", "assistant", "tool"]),
        content: text.nullable().optional(),
        name: name.optional(),
        tool_calls: z.array(call).min(1).max(16).optional(),
        tool_call_id: z.string().min(1).max(200).optional(),
      }),
    )
    .min(1)
    .max(128),
  tools: z
    .array(
      z.strictObject({
        type: z.literal("function"),
        function: z.strictObject({
          name,
          description: z.string().max(10000).optional(),
          parameters: schema.default({ type: "object", properties: {} }),
          strict: z.boolean().optional(),
        }),
      }),
    )
    .max(32)
    .default([]),
  tool_choice: z
    .union([
      z.enum(["none", "auto", "required"]),
      z.strictObject({
        type: z.literal("function"),
        function: z.strictObject({ name }),
      }),
    ])
    .optional(),
  parallel_tool_calls: z.boolean().default(true),
  response_format: z
    .union([
      z.strictObject({ type: z.literal("text") }),
      z.strictObject({ type: z.literal("json_object") }),
      z.strictObject({
        type: z.literal("json_schema"),
        json_schema: z.strictObject({
          name,
          description: z.string().optional(),
          schema,
          strict: z.boolean().optional(),
        }),
      }),
    ])
    .default({ type: "text" }),
  stream: z.boolean().default(false),
  stream_options: z
    .strictObject({ include_usage: z.boolean().optional() })
    .nullable()
    .optional(),
  n: z.literal(1).default(1),
  bridge: z
    .strictObject({
      execution: z.enum(["inference", "agent", "channel"]).default("inference"),
      background: z.boolean().default(false),
    })
    .prefault({}),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;
const bad = (message: string) =>
  new BridgeError("invalid_request", message, 400);
const invalid = (message: string) =>
  new BridgeError("invalid_completion", message, 502);
const envelope = z.strictObject({
  content: z.string().nullable(),
  tool_calls: z.array(z.strictObject({ name, arguments: z.string() })).max(16),
});
// Claude Code validates draft-07 schemas. Native JSON output constrains this envelope; client schemas are checked separately.
// Keeping them separate preserves local $ref roots and prevents schema collisions.
export const completionEnvelopeSchema = z.toJSONSchema(envelope, {
  target: "draft-7",
});
export const completionSystemPrompt = bridgePrompt("completion/system");
function compile(value: Record<string, unknown>): ValidateFunction {
  const maps = ["properties", "$defs", "definitions", "dependentSchemas"];
  const singles = [
    "items",
    "additionalProperties",
    "unevaluatedProperties",
    "unevaluatedItems",
    "propertyNames",
    "contains",
    "not",
    "if",
    "then",
    "else",
  ];
  const arrays = ["allOf", "anyOf", "oneOf", "prefixItems"];
  const allowed = new Set([
    ...maps,
    ...singles,
    ...arrays,
    "$schema",
    "$ref",
    "$comment",
    "title",
    "description",
    "default",
    "examples",
    "readOnly",
    "writeOnly",
    "deprecated",
    "type",
    "enum",
    "const",
    "required",
    "dependentRequired",
    "minProperties",
    "maxProperties",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minContains",
    "maxContains",
  ]);
  let nodes = 0;
  const ancestors = new Set<object>();
  function reference(ref: unknown): unknown {
    if (typeof ref !== "string" || (ref !== "#" && !ref.startsWith("#/")))
      throw bad("Only local JSON Pointer schema references are supported");
    let target: unknown = value;
    if (ref === "#") return target;
    let pointer: string;
    try {
      pointer = decodeURIComponent(ref.slice(2));
    } catch {
      throw bad("Invalid JSON Schema reference");
    }
    for (const encoded of pointer.split("/")) {
      if (/~(?:[^01]|$)/.test(encoded))
        throw bad("Invalid JSON Schema reference");
      const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
      if (!target || typeof target !== "object" || !Object.hasOwn(target, key))
        throw bad("Unresolved JSON Schema reference");
      target = (target as Record<string, unknown>)[key];
    }
    return target;
  }
  function visit(v: unknown, depth = 0): void {
    if (depth > 32 || ++nodes > 1500) throw bad("JSON Schema is too complex");
    if (typeof v === "boolean") return;
    if (!v || typeof v !== "object" || Array.isArray(v))
      throw bad("Invalid JSON Schema node");
    if (ancestors.has(v))
      throw bad("Cyclic JSON Schema references are unsupported");
    ancestors.add(v);
    const o = v as Record<string, unknown>;
    // Allowlisting covers every schema-bearing position. In particular $async
    // would return a Promise instead of a boolean, and regex validators can block
    // the event loop. References count toward the expanded complexity budget.
    for (const key of Object.keys(o))
      if (!allowed.has(key))
        throw bad("Unsupported JSON Schema keyword: " + key);
    if ("$ref" in o) visit(reference(o.$ref), depth + 1);
    for (const key of maps)
      if (o[key] && typeof o[key] === "object")
        for (const child of Object.values(o[key] as object))
          visit(child, depth + 1);
    for (const key of singles)
      if (o[key] !== undefined) visit(o[key], depth + 1);
    for (const key of arrays)
      if (Array.isArray(o[key]))
        for (const child of o[key]) visit(child, depth + 1);
    ancestors.delete(v);
  }
  visit(value);
  try {
    return new Ajv2020({
      strict: false,
      validateFormats: false,
      allErrors: false,
    }).compile(value);
  } catch {
    throw bad("Invalid or unresolved JSON Schema");
  }
}
function validators(request: ChatRequest) {
  return {
    tools: new Map(
      request.tools.map((t) => [
        t.function.name,
        compile(t.function.parameters),
      ]),
    ),
    output:
      request.response_format.type === "json_schema"
        ? compile(request.response_format.json_schema.schema)
        : undefined,
  };
}
export function prepareCompletion(raw: unknown): {
  request: ChatRequest;
  prompt: string;
  images: InputImage[];
} {
  let request: ChatRequest;
  try {
    request = chatRequestSchema.parse(raw);
  } catch {
    throw bad(
      "Unsupported or invalid Chat Completions fields; see docs/openai-compatible.md",
    );
  }
  const images: InputImage[] = [];
  let imageBytes = 0;
  const messages = request.messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((part) => {
          if (part.type !== "image_url") return part;
          if (
            message.role !== "user" ||
            request.bridge.execution !== "inference"
          )
            throw bad("Image input requires a user message in inference mode");
          if (images.length >= IMAGE_LIMITS.count)
            throw bad("A request supports at most five attached images");
          const image = decodeImage(part.image_url.url);
          imageBytes += image.data.length;
          if (imageBytes > IMAGE_LIMITS.decodedBytes)
            throw new BridgeError(
              "request_too_large",
              "Attached image data exceeds 6 MB",
              413,
            );
          images.push(image);
          return {
            type: "text" as const,
            text:
              bridgePrompt("completion/image-heading") +
              images.length +
              ": " +
              image.mime +
              ", " +
              image.width +
              "x" +
              image.height +
              bridgePrompt("completion/image-rules"),
          };
        })
      : message.content,
  }));
  const names = request.tools.map((t) => t.function.name);
  if (new Set(names).size !== names.length)
    throw bad("Function names must be unique");
  request.tool_choice ??= names.length ? "auto" : "none";
  if (
    (request.tool_choice === "required" ||
      typeof request.tool_choice === "object") &&
    !names.length
  )
    throw bad("tool_choice requires tools");
  if (
    typeof request.tool_choice === "object" &&
    !names.includes(request.tool_choice.function.name)
  )
    throw bad("Selected function is not declared");
  const pending = new Set<string>(),
    seen = new Set<string>();
  for (const message of request.messages) {
    if (message.role === "tool") {
      if (
        !message.tool_call_id ||
        !pending.delete(message.tool_call_id) ||
        message.content == null ||
        message.tool_calls
      )
        throw bad("Tool result does not match a pending function call");
    } else {
      if (pending.size)
        throw bad(
          "Every function call requires its tool result before another message",
        );
      if (message.tool_call_id)
        throw bad("tool_call_id is valid only on tool messages");
      if (message.tool_calls) {
        if (message.role !== "assistant")
          throw bad("Only assistant messages can call functions");
        for (const c of message.tool_calls) {
          if (seen.has(c.id)) throw bad("Function call IDs must be unique");
          try {
            JSON.parse(c.function.arguments);
          } catch {
            throw bad("Function arguments must be JSON");
          }
          seen.add(c.id);
          pending.add(c.id);
        }
      }
      if (message.content == null && !message.tool_calls)
        throw bad("Message content is required");
    }
  }
  if (pending.size) throw bad("Tool results are missing");
  if (request.bridge.background && request.stream)
    throw bad("Background requests return a job receipt; stream must be false");
  if (request.bridge.execution === "channel" && !request.bridge.background)
    throw bad("Host conversation work requires background=true");
  if (
    request.bridge.execution !== "inference" &&
    (request.messages.length !== 1 ||
      request.messages[0]?.role !== "user" ||
      typeof request.messages[0]?.content !== "string" ||
      request.tools.length ||
      request.response_format.type !== "text")
  )
    throw bad(
      "Native agent/channel execution requires one text user message and no client tools or response_format",
    );
  validators(request);
  const prompt =
    request.bridge.execution !== "inference"
      ? (request.messages[0]!.content as string)
      : bridgePrompt("completion/request-heading") +
        JSON.stringify({
          messages,
          tools: request.tools,
          tool_choice: request.tool_choice,
          parallel_tool_calls: request.parallel_tool_calls,
          response_format: request.response_format,
        });
  if (prompt.length > 100000)
    throw new BridgeError(
      "request_too_large",
      "Expanded conversation exceeds 100000 characters",
      413,
    );
  return { request, prompt, images };
}
export function parseCompletionResult(raw: string, request: ChatRequest) {
  let result: z.infer<typeof envelope>;
  try {
    result = envelope.parse(JSON.parse(raw));
  } catch {
    throw invalid("Selected worker did not return a valid completion envelope");
  }
  const checks = validators(request),
    calls = result.tool_calls;
  if (calls.length) {
    if (
      request.tool_choice === "none" ||
      (!request.parallel_tool_calls && calls.length > 1)
    )
      throw invalid("Claude violated the requested function-call policy");
    if (result.content !== null)
      throw invalid(
        "Function calls must not include an unvalidated text answer",
      );
    for (const c of calls) {
      const validate = checks.tools.get(c.name);
      if (
        !validate ||
        (typeof request.tool_choice === "object" &&
          c.name !== request.tool_choice.function.name)
      )
        throw invalid("Claude requested an undeclared function");
      let args: unknown;
      try {
        args = JSON.parse(c.arguments);
      } catch {
        throw invalid("Function arguments are not JSON");
      }
      try {
        if (!validate(args))
          throw invalid("Function arguments do not match the declared schema");
      } catch {
        throw invalid("Function arguments do not match the declared schema");
      }
    }
  } else {
    if (
      request.tool_choice === "required" ||
      typeof request.tool_choice === "object"
    )
      throw invalid("Claude did not call the required function");
    if (result.content === null)
      throw invalid("Claude returned neither text nor a function call");
    if (request.response_format.type !== "text") {
      let value: unknown;
      try {
        value = JSON.parse(result.content);
      } catch {
        throw invalid("Selected worker did not return JSON content");
      }
      if (
        request.response_format.type === "json_object" &&
        (!value || typeof value !== "object" || Array.isArray(value))
      )
        throw invalid("Expected a JSON object");
      try {
        if (checks.output && !checks.output(value))
          throw invalid("JSON output does not match the declared schema");
      } catch {
        throw invalid("JSON output does not match the declared schema");
      }
    }
  }
  return { content: result.content, toolCalls: calls };
}

export function completionResponse(job: Job, request: ChatRequest) {
  const output = job.completion
    ? parseCompletionResult(job.result ?? "", request)
    : { content: job.result ?? "", toolCalls: [] };
  return {
    id: "chatcmpl-" + job.id,
    object: "chat.completion",
    created: Math.floor(Date.parse(job.createdAt) / 1000),
    model: request.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: output.content,
          ...(output.toolCalls.length
            ? {
                tool_calls: output.toolCalls.map((c, index) => ({
                  id: "call_" + job.id.replaceAll("-", "") + "_" + index,
                  type: "function",
                  function: { name: c.name, arguments: c.arguments },
                })),
              }
            : {}),
        },
        finish_reason: output.toolCalls.length ? "tool_calls" : "stop",
      },
    ],
    ...(job.usage ? { usage: job.usage } : {}),
  };
}
