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

declare module "node:crypto" {
  interface Hash {
    update(data: string): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare module "node:fs/promises" {
  export function readFile(
    path: string,
    encoding: "utf8",
  ): Promise<string>;
  export function writeFile(
    path: string,
    data: string,
    encoding: "utf8",
  ): Promise<void>;
  export function mkdir(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<string | undefined>;
  export function rm(
    path: string,
    options?: { force?: boolean; recursive?: boolean },
  ): Promise<void>;
}

declare module "node:path" {
  export function join(...segments: string[]): string;
}
