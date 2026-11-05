import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "disclosures-package-"));
const run = (command, args, cwd = dir) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"],
  });
try {
  const [pack] = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", dir], root),
  );
  const allowed = /^(dist\/|README\.md$|LICENSE$|NOTICE$|package\.json$)/;
  assert(
    pack.files.every((file) => allowed.test(file.path)),
    "Unexpected package files",
  );
  assert(
    pack.files.some((file) => file.path === "dist/server.d.ts"),
    "Missing declarations",
  );
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    join(dir, pack.filename),
  ]);
  await copyFile(
    join(root, "scripts/fixtures/installed-consumer.mjs"),
    join(dir, "installed-consumer.mjs"),
  );
  await writeFile(
    join(dir, "consumer.ts"),
    `
import { z } from "zod";
import { z as z3 } from "zod/v3";
import { createTools, createDisclosuresServer, defineTool, runHttpServer, textResult, type AdapterOptions, type ToolDefinition } from "disclosures";
const options: AdapterOptions = { env: {}, fetchFn: async () => Response.json({}) };
const tools: ToolDefinition[] = createTools(options);
const server = createDisclosuresServer(options);
void tools; void server; void runHttpServer;
// @ts-expect-error boundary must retain its input types
createTools({ fetchFn: 123 });
// Custom tools accept Zod 4 and Zod 3 shapes with typed, optional-aware args.
const v4 = defineTool("V4", "d", { q: z.string(), n: z.number().optional() }, async (args) => {
  const q: string = args.q;
  const n: number | undefined = args.n;
  return textResult(q + String(n));
});
const v3 = defineTool("V3", "d", { q: z3.string(), n: z3.number().optional() }, async (args) => {
  const q: string = args.q;
  const n: number | undefined = args.n;
  return textResult(q + String(n));
});
void v4.handler({ q: "x" }); void v3.handler({ q: "x" });
// @ts-expect-error handler args stay typed
defineTool("Bad", "d", { q: z.string() }, async (args) => textResult(String(args.q satisfies number)));
`,
  );
  // Use the repository's pinned compiler, with no consumer-only type dependencies.
  run(process.execPath, [
    join(root, "node_modules/typescript/bin/tsc"),
    "--noEmit",
    "--strict",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--target",
    "ES2022",
    "consumer.ts",
  ]);
  const importResult = run(process.execPath, [
    "--input-type=module",
    "-e",
    'import { createTools } from "disclosures"; console.log(createTools().length)',
  ]);
  assert.equal(importResult.trim(), "10");
  const runtimeResult = run(process.execPath, ["installed-consumer.mjs"]);
  process.stdout.write(runtimeResult);
  console.log(
    "Packed package: clean strict TypeScript consumer and Node import passed.",
  );
} catch (error) {
  if (error.stdout) console.error(String(error.stdout));
  if (error.stderr) console.error(String(error.stderr));
  throw error;
} finally {
  await rm(dir, { recursive: true, force: true });
}
