// Minimal ambient declarations for the two Node builtins the CLI entrypoint
// uses. The published bundle runs on Node 18+, but the dependency policy
// (zod + MCP SDK only) precludes @types/node.
declare module "node:fs" {
  export function realpathSync(path: string): string;
}

declare module "node:url" {
  export function pathToFileURL(path: string): { href: string };
}
