declare module "bun:test" {
  export function expect(actual: unknown): {
    toBe(expected: unknown): void;
    toBeInstanceOf(expected: new (...args: any[]) => unknown): void;
    toEqual(expected: unknown): void;
    toMatch(expected: RegExp | string): void;
  };
}
