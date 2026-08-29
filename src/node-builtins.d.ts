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
    update(data: Uint8Array): Hash;
    digest(encoding: "hex"): string;
    digest(): Uint8Array;
  }
  export function createHash(algorithm: string): Hash;
  // Used by the PDF text extractor to open documents encrypted with an empty
  // user password (owner-password-protected filings). Node's Decipher accepts
  // and returns Buffer, which is a Uint8Array at runtime.
  interface Decipher {
    update(data: Uint8Array): Buffer;
    final(): Buffer;
    setAutoPadding(autoPadding: boolean): Decipher;
  }
  export function createDecipheriv(
    algorithm: string,
    key: Uint8Array,
    iv: Uint8Array,
  ): Decipher;
  // Test-fixture side only (tests/helpers/pdfFixture.ts builds an encrypted PDF).
  interface Cipher {
    update(data: Uint8Array): Buffer;
    final(): Buffer;
    setAutoPadding(autoPadding: boolean): Cipher;
  }
  export function createCipheriv(
    algorithm: string,
    key: Uint8Array,
    iv: Uint8Array,
  ): Cipher;
  export function randomBytes(size: number): Buffer;
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

// Minimal Buffer surface (a Uint8Array subclass at runtime) for the raw
// node:http/https client path; @types/node is intentionally not a dependency.
interface Buffer extends Uint8Array {}
declare const Buffer: {
  concat(list: readonly Uint8Array[]): Buffer;
  alloc(size: number): Buffer;
  from(data: Uint8Array | ArrayLike<number>): Buffer;
};

declare module "node:http" {
  export interface IncomingMessage {
    url?: string;
    method?: string;
    statusCode?: number;
    statusMessage?: string;
    headers: Record<string, string | string[] | undefined>;
    on(event: "data", listener: (chunk: Buffer) => void): this;
    on(event: "end", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
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
  export interface ClientRequestOptions {
    method?: string;
    headers?: Record<string, string>;
    insecureHTTPParser?: boolean;
  }
  export interface ClientRequest {
    on(event: "error", listener: (error: Error) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
    destroy(error?: Error): void;
    end(): void;
  }
  export function request(
    url: string,
    options: ClientRequestOptions,
    callback: (res: IncomingMessage) => void,
  ): ClientRequest;
}

declare module "node:https" {
  import type {
    ClientRequest,
    ClientRequestOptions,
    IncomingMessage,
  } from "node:http";
  export function request(
    url: string,
    options: ClientRequestOptions,
    callback: (res: IncomingMessage) => void,
  ): ClientRequest;
}
