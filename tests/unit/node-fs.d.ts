// The few Node APIs the unit tests use (the project's types are browser-only).
declare module 'node:fs' {
  export function readFileSync(path: string | URL): Uint8Array;
  export function writeFileSync(path: string, data: Uint8Array): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
}
