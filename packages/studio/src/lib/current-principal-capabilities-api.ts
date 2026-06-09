import {
  RuntimeError,
  type CurrentPrincipalCapabilitiesResponse,
} from "@mdcms/shared";
import { z } from "zod";

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

const nonEmptyResponseStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0);

const currentPrincipalCapabilitiesDataSchema: z.ZodType<CurrentPrincipalCapabilitiesResponse> =
  z.object({
    project: nonEmptyResponseStringSchema,
    environment: nonEmptyResponseStringSchema,
    capabilities: z.object({
      schema: z.object({
        read: z.boolean(),
        write: z.boolean(),
      }),
      content: z.object({
        read: z.boolean(),
        readDraft: z.boolean(),
        write: z.boolean(),
        publish: z.boolean(),
        unpublish: z.boolean(),
        delete: z.boolean(),
      }),
      users: z.object({
        manage: z.boolean(),
      }),
      settings: z.object({
        manage: z.boolean(),
      }),
      media: z
        .object({
          read: z.boolean(),
          upload: z.boolean(),
          delete: z.boolean(),
        })
        .default({ read: false, upload: false, delete: false }),
      ai: z
        .object({
          use: z.boolean(),
        })
        .default({ use: false }),
    }),
  });

const currentPrincipalCapabilitiesRoutePayloadSchema = z.object({
  data: currentPrincipalCapabilitiesDataSchema,
});

function validateCurrentPrincipalCapabilitiesResponse(
  operation: string,
  payload: unknown,
): CurrentPrincipalCapabilitiesResponse {
  try {
    return currentPrincipalCapabilitiesRoutePayloadSchema.parse(
      extractRoutePayload(payload),
    ).data;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw toInvalidResponseError(operation, payload);
    }

    throw error;
  }
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
