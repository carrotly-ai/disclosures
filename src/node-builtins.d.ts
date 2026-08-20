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
  export function writeFile(
    path: string,
    data: Uint8Array,
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
  export function isAbsolute(path: string): boolean;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:http" {
  export interface IncomingMessage {
    url?: string;
    method?: string;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }
  export interface ServerResponse {
    headersSent: boolean;
    writeHead(status: number, headers?: Record<string, string>): ServerResponse;
    end(body?: string): void;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }
  export interface Server {
    listen(port: number, host: string, listeningListener?: () => void): Server;
    close(callback?: (err?: Error) => void): Server;
    address(): { port: number } | string | null;
    once(event: string, listener: (...args: unknown[]) => void): Server;
    removeListener(event: string, listener: (...args: unknown[]) => void): Server;
  }
  export function createServer(
    requestListener: (req: IncomingMessage, res: ServerResponse) => void,
  ): Server;
}
