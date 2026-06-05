import {
  RuntimeError,
  type CurrentPrincipalCapabilitiesResponse,
} from "@mdcms/shared";

import type { MdcmsConfig } from "./studio-component.js";
import {
  applyStudioAuthToRequestInit,
  type StudioRuntimeAuth,
} from "./request-auth.js";
import { resolveStudioRelativeUrl } from "./url-resolution.js";

export type StudioCurrentPrincipalCapabilitiesConfig = Pick<
  MdcmsConfig,
  "project" | "environment" | "serverUrl"
>;

export type StudioCurrentPrincipalCapabilitiesApiOptions = {
  auth?: StudioRuntimeAuth;
  fetcher?: typeof fetch;
};

export type StudioCurrentPrincipalCapabilitiesApi = {
  get: () => Promise<CurrentPrincipalCapabilitiesResponse>;
};

type RoutePayload = {
  code?: unknown;
  message?: unknown;
  data?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function mergeHeaders(
  ...headerSets: Array<HeadersInit | undefined>
): HeadersInit | undefined {
  const headers = new Headers();

  for (const headerSet of headerSets) {
    if (!headerSet) {
      continue;
    }

    new Headers(headerSet).forEach((value, key) => {
      headers.set(key, value);
    });
  }

  return Array.from(headers.entries()).length > 0
    ? Object.fromEntries(headers.entries())
    : undefined;
}

function buildUrl(
  config: StudioCurrentPrincipalCapabilitiesConfig,
  path: string,
): URL {
  return resolveStudioRelativeUrl(path, config.serverUrl);
}

async function readResponsePayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function extractRoutePayload(payload: unknown): RoutePayload {
  if (!isRecord(payload)) {
    return {};
  }

  return {
    code: payload.code,
    message: payload.message,
    data: payload.data,
  };
}

function toRouteFailureError(
  operation: string,
  response: Response,
  payload: unknown,
  fallbackMessage: string,
): RuntimeError {
  const parsed = extractRoutePayload(payload);
  const code =
    typeof parsed.code === "string" && parsed.code.trim().length > 0
      ? parsed.code
      : "CURRENT_PRINCIPAL_CAPABILITIES_REQUEST_FAILED";
  const message =
    typeof parsed.message === "string" && parsed.message.trim().length > 0
      ? parsed.message
      : fallbackMessage;

  return new RuntimeError({
    code,
    message,
    statusCode: response.status,
    details: {
      operation,
      status: response.status,
      payload,
    },
  });
}

function toInvalidResponseError(
  operation: string,
  payload: unknown,
): RuntimeError {
  return new RuntimeError({
    code: "CURRENT_PRINCIPAL_CAPABILITIES_RESPONSE_INVALID",
    message: "Current principal capabilities response is invalid.",
    statusCode: 500,
    details: {
      operation,
      payload,
    },
  });
}

function validateBooleanRecord(
  value: unknown,
  keys: readonly string[],
  path: string,
): Record<string, boolean> {
  if (!isRecord(value)) {
    throw toInvalidResponseError(path, value);
  }

  const record: Record<string, boolean> = {};

  for (const key of keys) {
    const entry = value[key];
    if (!isBoolean(entry)) {
      throw toInvalidResponseError(path, value);
    }
    record[key] = entry;
  }

  return record;
}

function validateCurrentPrincipalCapabilitiesResponse(
  operation: string,
  payload: unknown,
): CurrentPrincipalCapabilitiesResponse {
  const parsed = extractRoutePayload(payload);

  if (!isRecord(parsed.data)) {
    throw toInvalidResponseError(operation, payload);
  }

  const data = parsed.data;
  if (
    !isNonEmptyString(data.project) ||
    !isNonEmptyString(data.environment) ||
    !isRecord(data.capabilities)
  ) {
    throw toInvalidResponseError(operation, payload);
  }

  const capabilities = data.capabilities;
  const schema = validateBooleanRecord(
    capabilities.schema,
    ["read", "write"],
    operation,
  );
  const content = validateBooleanRecord(
    capabilities.content,
    ["read", "readDraft", "write", "publish", "unpublish", "delete"],
    operation,
  );
  const users = validateBooleanRecord(
    capabilities.users,
    ["manage"],
    operation,
  );
  const settings = validateBooleanRecord(
    capabilities.settings,
    ["manage"],
    operation,
  );
  const media = isRecord(capabilities.media)
    ? validateBooleanRecord(
        capabilities.media,
        ["read", "upload", "delete"],
        operation,
      )
    : { read: false, upload: false, delete: false };
  const ai = isRecord(capabilities.ai)
    ? validateBooleanRecord(capabilities.ai, ["use"], operation)
    : { use: false };

  return {
    project: data.project,
    environment: data.environment,
    capabilities: {
      schema: {
        read: schema.read,
        write: schema.write,
      },
      content: {
        read: content.read,
        readDraft: content.readDraft,
        write: content.write,
        publish: content.publish,
        unpublish: content.unpublish,
        delete: content.delete,
      },
      users: {
        manage: users.manage,
      },
      settings: {
        manage: settings.manage,
      },
      media: {
        read: media.read,
        upload: media.upload,
        delete: media.delete,
      },
      ai: {
        use: ai.use,
      },
    },
  };
}

async function requestCapabilitiesRouteJson(
  options: StudioCurrentPrincipalCapabilitiesApiOptions,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<unknown> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(
    input,
    applyStudioAuthToRequestInit(options.auth, init),
  );
  const payload = await readResponsePayload(response);

  if (!response.ok) {
    throw toRouteFailureError(
      init.method ?? "GET",
      response,
      payload,
      "Current principal capabilities request failed.",
    );
  }

  return payload;
}

export function createStudioCurrentPrincipalCapabilitiesApi(
  config: StudioCurrentPrincipalCapabilitiesConfig,
  options: StudioCurrentPrincipalCapabilitiesApiOptions = {},
): StudioCurrentPrincipalCapabilitiesApi {
  return {
    async get() {
      const payload = await requestCapabilitiesRouteJson(
        options,
        buildUrl(config, "/api/v1/me/capabilities"),
        {
          method: "GET",
          headers: mergeHeaders({
            "x-mdcms-project": config.project,
            "x-mdcms-environment": config.environment,
          }),
        },
      );

      return validateCurrentPrincipalCapabilitiesResponse(
        "GET /api/v1/me/capabilities",
        payload,
      );
    },
  };
}
