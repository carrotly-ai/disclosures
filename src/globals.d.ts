declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode?: number;
  stderr: { write(message: string): void };
  cwd(): string;
};
