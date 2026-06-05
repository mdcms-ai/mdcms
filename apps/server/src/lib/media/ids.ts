import { RuntimeError } from "@mdcms/shared";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseMediaId(value: unknown): string {
  if (typeof value === "string" && UUID_PATTERN.test(value)) {
    return value;
  }

  throw new RuntimeError({
    code: "INVALID_INPUT",
    message: "Media id must be a UUID.",
    statusCode: 400,
    details: { field: "id" },
  });
}
