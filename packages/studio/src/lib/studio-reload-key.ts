import type { StudioMountContext } from "@mdcms/shared";

import type { MdcmsConfig } from "./studio.js";

/**
 * Reload keys let `<Studio>` decide whether a new `config` or `auth` prop
 * describes a different Studio, or only a new object with the same values.
 * Hosts commonly rebuild both on every render; reloading on identity would
 * unmount the runtime (and any open editor) each time the host re-renders.
 *
 * Serialization rules:
 * - Primitives, arrays and plain objects are compared by value, with object
 *   keys sorted so property order does not matter.
 * - Functions (component `load`/`loadPropsEditor`, `resolvePreviewUrl`,
 *   `extend`) are compared by presence only. Hosts often create them inline,
 *   and the runtime keeps the functions from the config it loaded with.
 * - Any other object (for example a field schema instance) is compared by
 *   identity, because its internals are not plain data. Configs built from
 *   the same module-level schema objects therefore produce the same key.
 */
export function createStudioConfigReloadKey(config: MdcmsConfig): string {
  return serializeReloadValue(config, new WeakSet());
}

export function createStudioAuthReloadKey(
  auth: StudioMountContext["auth"] | undefined,
): string {
  return auth === undefined
    ? "undefined"
    : serializeReloadValue(auth, new WeakSet());
}

const FUNCTION_MARKER = "[function]";
const CIRCULAR_MARKER = "[circular]";

const objectIdentities = new WeakMap<object, number>();
let nextObjectIdentity = 0;

function readObjectIdentity(value: object): number {
  const existing = objectIdentities.get(value);

  if (existing !== undefined) {
    return existing;
  }

  nextObjectIdentity += 1;
  objectIdentities.set(value, nextObjectIdentity);
  return nextObjectIdentity;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serializeReloadValue(
  value: unknown,
  ancestors: WeakSet<object>,
): string {
  if (value === undefined) {
    return "undefined";
  }

  if (typeof value === "function") {
    return JSON.stringify(FUNCTION_MARKER);
  }

  if (typeof value === "bigint") {
    return JSON.stringify(`${value.toString()}n`);
  }

  if (typeof value === "symbol") {
    return JSON.stringify(value.toString());
  }

  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (ancestors.has(value)) {
    return JSON.stringify(CIRCULAR_MARKER);
  }

  if (Array.isArray(value)) {
    ancestors.add(value);
    const items = value.map((item) => serializeReloadValue(item, ancestors));
    ancestors.delete(value);
    return `[${items.join(",")}]`;
  }

  if (!isPlainObject(value)) {
    return JSON.stringify(`[object#${readObjectIdentity(value)}]`);
  }

  ancestors.add(value);
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map(
      (key) =>
        `${JSON.stringify(key)}:${serializeReloadValue(record[key], ancestors)}`,
    );
  ancestors.delete(value);

  return `{${entries.join(",")}}`;
}
