declare module "bun:test" {
  export function test(label: string, fn: () => void | Promise<void>): void;
}
