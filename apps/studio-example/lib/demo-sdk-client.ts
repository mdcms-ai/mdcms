import {
  MdcmsApiError,
  MdcmsClientError,
  createClient,
  type MdcmsClient,
} from "@mdcms/sdk";

import config from "../mdcms.config";

export type DemoRequestFailure = {
  status: number;
  code: string;
  message: string;
};

class DemoConfigError extends Error {
  readonly status = 500;
  readonly code = "CONFIG_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "DemoConfigError";
  }
}

function getDemoApiKey(): string {
  const apiKey = process.env.MDCMS_DEMO_API_KEY?.trim();

  if (!apiKey) {
    throw new DemoConfigError(
      "Set MDCMS_DEMO_API_KEY to enable the rendered example routes.",
    );
  }

  return apiKey;
}

export function createDemoSdkClient(): MdcmsClient {
  return createClient({
    serverUrl: config.serverUrl,
    apiKey: getDemoApiKey(),
    project: config.project,
    environment: config.environment,
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        cache: "no-store",
      }),
  });
}

export function toDemoRequestFailure(error: unknown): DemoRequestFailure {
  if (error instanceof DemoConfigError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
    };
  }

  if (error instanceof MdcmsApiError) {
    return {
      status: error.statusCode,
      code: error.code,
      message: error.message,
    };
  }

  if (error instanceof MdcmsClientError) {
    return {
      status: 502,
      code: error.code,
      message: error.message,
    };
  }

  return {
    status: 502,
    code: "REMOTE_ERROR",
    message:
      error instanceof Error
        ? `Failed to reach content API: ${error.message}`
        : "Failed to reach content API.",
  };
}
