import { RuntimeError } from "@mdcms/shared";

const WEBHOOK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseWebhookId(value: unknown): string {
  if (typeof value !== "string" || !WEBHOOK_ID_PATTERN.test(value.trim())) {
    throw new RuntimeError({
      code: "INVALID_INPUT",
      message: 'Path parameter "id" must be a webhook UUID.',
      statusCode: 400,
      details: { field: "id" },
    });
  }

  return value.trim().toLowerCase();
}
