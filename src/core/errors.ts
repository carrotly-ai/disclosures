import type { DataSource } from "./types.js";

export class AdapterError extends Error {
  constructor(
    message: string,
    readonly source?: DataSource,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

export class AdapterConfigurationError extends AdapterError {
  constructor(message: string, source?: DataSource) {
    super(message, source);
    this.name = "AdapterConfigurationError";
  }
}

export class AdapterRateLimitError extends AdapterError {
  constructor(
    message: string,
    readonly limit: number,
    readonly windowMs: number,
    source?: DataSource,
  ) {
    super(message, source);
    this.name = "AdapterRateLimitError";
  }
}
