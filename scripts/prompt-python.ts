/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0 */
export function promptPython(environment: {
  BRIDGE_PROMPT_PYTHON?: string;
  BRIDGE_PYTHON?: string;
}): string {
  return (
    environment.BRIDGE_PROMPT_PYTHON ?? environment.BRIDGE_PYTHON ?? "python3"
  );
}
