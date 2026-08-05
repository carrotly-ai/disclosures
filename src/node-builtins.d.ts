// Minimal ambient declarations for the Node builtins used by the package.
// The published bundle runs on Node 18+, but the dependency policy
// (zod + MCP SDK only) precludes @types/node.
declare module "node:fs" {
  export function realpathSync(path: string): string;
}

declare module "node:url" {
  export function pathToFileURL(path: string): { href: string };
}

declare module "node:zlib" {
  export function inflateRawSync(
    data: Uint8Array,
    options?: { maxOutputLength?: number },
  ): Uint8Array;
}
