import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function workspaceRoot(): string {
  let candidate = process.cwd();
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(candidate, "pnpm-workspace.yaml"))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error("Workspace root unavailable; configuration cannot be loaded.");
}