import {
  RuntimeError,
  extendEnv,
  parseCoreEnv,
  type CoreEnv,
} from "@mdcms/shared";
import { z } from "zod";

const OIDC_PROVIDER_IDS = [
  "okta",
  "azure-ad",
  "google-workspace",
  "auth0",
] as const;
const DEFAULT_OIDC_SCOPES = ["openid", "email", "profile"] as const;
const TOKEN_ENDPOINT_AUTH_METHODS = [
  "client_secret_basic",
  "client_secret_post",
] as const;
const NonEmptyStringSchema = z.string().trim().min(1);
const AbsoluteUrlStringSchema = NonEmptyStringSchema.url();
const NormalizedAbsoluteUrlSchema = AbsoluteUrlStringSchema.transform((raw) =>
  normalizeAbsoluteUrl(raw),
);
const OriginSchema = AbsoluteUrlStringSchema.transform((raw, ctx) => {
  const normalized = normalizeAbsoluteUrl(raw);
  const url = new URL(normalized);

  if (
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    (normalized !== url.origin && normalized !== url.origin + "/")
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "must be an absolute origin in scheme://host[:port] form.",
    });
    return z.NEVER;
  }

  return url.origin;
});
const OidcProviderSchema = z.object({
  providerId: NonEmptyStringSchema.pipe(z.enum(OIDC_PROVIDER_IDS)),
  issuer: NormalizedAbsoluteUrlSchema,
  domain: NonEmptyStringSchema.transform((value) => value.toLowerCase()),
  clientId: NonEmptyStringSchema,
  clientSecret: NonEmptyStringSchema,
  scopes: z
    .array(NonEmptyStringSchema)
    .min(1)
    .default([...DEFAULT_OIDC_SCOPES]),
  trustedOrigins: z.array(OriginSchema).optional(),
  discoveryOverrides: z
    .object({
      authorizationEndpoint: NormalizedAbsoluteUrlSchema.optional(),
      tokenEndpoint: NormalizedAbsoluteUrlSchema.optional(),
      userInfoEndpoint: NormalizedAbsoluteUrlSchema.optional(),
      jwksUri: NormalizedAbsoluteUrlSchema.optional(),
      tokenEndpointAuthMethod: z.enum(TOKEN_ENDPOINT_AUTH_METHODS).optional(),
    })
    .strict()
    .optional(),
});
const SamlAttributeMappingSchema = z
  .object({
    id: NonEmptyStringSchema.optional(),
    email: NonEmptyStringSchema.optional(),
    name: NonEmptyStringSchema.optional(),
    firstName: NonEmptyStringSchema.optional(),
    lastName: NonEmptyStringSchema.optional(),
  })
  .strict();
const OidcProvidersSchema = z
  .array(OidcProviderSchema)
  .superRefine((providers, ctx) => {
    const providerIds = new Set<string>();
    const domains = new Set<string>();

    for (const [index, provider] of providers.entries()) {
      if (providerIds.has(provider.providerId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "providerId"],
          message: `providerId ${provider.providerId} must be unique.`,
        });
      } else {
        providerIds.add(provider.providerId);
      }

      if (domains.has(provider.domain)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "domain"],
          message: `domain ${provider.domain} must be unique.`,
        });
      } else {
        domains.add(provider.domain);
      }
    }
  });
const SamlProviderSchema = z.object({
  providerId: NonEmptyStringSchema,
  issuer: NonEmptyStringSchema,
  domain: NonEmptyStringSchema.transform((value) => value.toLowerCase()),
  entryPoint: NormalizedAbsoluteUrlSchema,
  cert: NonEmptyStringSchema,
  audience: NonEmptyStringSchema.optional(),
  spEntityId: NonEmptyStringSchema.optional(),
  identifierFormat: NonEmptyStringSchema.optional(),
  authnRequestsSigned: z.boolean().optional(),
  wantAssertionsSigned: z.boolean().optional(),
  attributeMapping: SamlAttributeMappingSchema.optional(),
});
const SamlProvidersSchema = z
  .array(SamlProviderSchema)
  .superRefine((providers, ctx) => {
    const providerIds = new Set<string>();
    const domains = new Set<string>();

    for (const [index, provider] of providers.entries()) {
      if (providerIds.has(provider.providerId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "providerId"],
          message: `providerId ${provider.providerId} must be unique.`,
        });
      } else {
        providerIds.add(provider.providerId);
      }

      if (domains.has(provider.domain)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "domain"],
          message: `domain ${provider.domain} must be unique.`,
        });
      } else {
        domains.add(provider.domain);
      }
    }
  });
const ServerEnvExtensionSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).optional().default(4000),
  SERVICE_NAME: z
    .string()
    .optional()
    .transform((value) => value?.trim() || "mdcms-server"),
  SMTP_HOST: z.string().trim().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional().default(587),
  SMTP_FROM: z.string().trim().min(1).optional(),
  MDCMS_PREVIEW_TOKEN_SECRET: z.string().trim().min(1).optional(),
  MDCMS_HTTP_COMPRESS: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value.trim().length === 0) {
        return true;
      }
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") {
        return true;
      }
      if (normalized === "false") {
        return false;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "MDCMS_HTTP_COMPRESS must be true or false.",
      });
      return z.NEVER;
    }),
});

export type OidcProviderId = (typeof OIDC_PROVIDER_IDS)[number];
export type OidcTokenEndpointAuthMethod =
  (typeof TOKEN_ENDPOINT_AUTH_METHODS)[number];

export type OidcDiscoveryOverrides = {
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userInfoEndpoint?: string;
  jwksUri?: string;
  tokenEndpointAuthMethod?: OidcTokenEndpointAuthMethod;
};

export type OidcProviderConfig = {
  providerId: OidcProviderId;
  issuer: string;
  domain: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  trustedOrigins?: string[];
  discoveryOverrides?: OidcDiscoveryOverrides;
};

export type SamlAttributeMapping = {
  id?: string;
  email?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
};

export type SamlProviderConfig = {
  providerId: string;
  issuer: string;
  domain: string;
  entryPoint: string;
  cert: string;
  audience?: string;
  spEntityId?: string;
  identifierFormat?: string;
  authnRequestsSigned?: boolean;
  wantAssertionsSigned?: boolean;
  attributeMapping?: SamlAttributeMapping;
};

export type ServerEnv = CoreEnv & {
  PORT: number;
  SERVICE_NAME: string;
  SMTP_HOST?: string;
  SMTP_PORT: number;
  SMTP_FROM?: string;
  /**
   * Operator kill switch for Studio runtime publication. Enable via env and
   * restart/redeploy; there is no public mutation endpoint in v1.
   */
  MDCMS_STUDIO_RUNTIME_DISABLED: boolean;
  MDCMS_AUTH_OIDC_PROVIDERS: OidcProviderConfig[];
  MDCMS_AUTH_SAML_PROVIDERS: SamlProviderConfig[];
  MDCMS_STUDIO_ALLOWED_ORIGINS: string[];
  MDCMS_PREVIEW_TOKEN_SECRET?: string;
  /**
   * App-level compression toggle. Defaults to enabled because Railway's edge
   * proxy (and many self-hosting setups) does not auto-compress; if a fronting
   * reverse proxy / CDN is already handling compression, set this to "false"
   * to skip the per-response CPU cost.
   */
  MDCMS_HTTP_COMPRESS: boolean;
};

function normalizeAbsoluteUrl(raw: string): string {
  const url = new URL(raw);

  if (
    url.pathname === "/" &&
    url.search.length === 0 &&
    url.hash.length === 0 &&
    !raw.endsWith("/")
  ) {
    return url.origin;
  }

  return url.toString();
}

function createInvalidEnvError(
  value: unknown,
  message: string,
  details: Record<string, unknown> = {},
): RuntimeError {
  return new RuntimeError({
    code: "INVALID_ENV",
    message,
    details: {
      key: "MDCMS_AUTH_OIDC_PROVIDERS",
      value,
      ...details,
    },
  });
}

function createSamlInvalidEnvError(
  value: unknown,
  message: string,
  details: Record<string, unknown> = {},
): RuntimeError {
  return new RuntimeError({
    code: "INVALID_ENV",
    message,
    details: {
      key: "MDCMS_AUTH_SAML_PROVIDERS",
      value,
      ...details,
    },
  });
}

function createStudioAllowedOriginsInvalidEnvError(
  value: unknown,
  message: string,
  details: Record<string, unknown> = {},
): RuntimeError {
  return new RuntimeError({
    code: "INVALID_ENV",
    message,
    details: {
      key: "MDCMS_STUDIO_ALLOWED_ORIGINS",
      value,
      ...details,
    },
  });
}

function parseStudioRuntimeDisabledFlag(rawValue: string | undefined): boolean {
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return false;
  }

  const normalized = rawValue.trim().toLowerCase();

  if (normalized === "true") {
    return true;
  }

  if (normalized === "false") {
    return false;
  }

  throw new RuntimeError({
    code: "INVALID_ENV",
    message: "MDCMS_STUDIO_RUNTIME_DISABLED must be true or false.",
    details: {
      key: "MDCMS_STUDIO_RUNTIME_DISABLED",
      value: rawValue,
    },
  });
}

function throwInvalidPortEnvError(rawValue: string | undefined): never {
  throw new RuntimeError({
    code: "INVALID_ENV",
    message: "PORT must be an integer between 1 and 65535.",
    details: {
      key: "PORT",
      value: rawValue ?? "4000",
    },
  });
}

function parseStudioAllowedOrigins(rawValue: string | undefined): string[] {
  if (!rawValue || rawValue.trim().length === 0) {
    return [];
  }

  return rawValue
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((origin, index) => {
      const parsed = OriginSchema.safeParse(origin);

      if (!parsed.success) {
        throw createStudioAllowedOriginsInvalidEnvError(
          origin,
          "MDCMS_STUDIO_ALLOWED_ORIGINS entries must be absolute origins in scheme://host[:port] form.",
          {
            index,
          },
        );
      }

      return parsed.data;
    });
}

function readIssueValue(
  value: unknown,
  path: readonly (string | number)[],
): unknown {
  let current = value;

  for (const segment of path) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    ) {
      return current;
    }

    current = (current as Record<string | number, unknown>)[segment];
  }

  return current;
}

function isNonEmptyStringIssue(issue: z.ZodIssue): boolean {
  return issue.code === "invalid_type" || issue.code === "too_small";
}

function throwOidcProvidersEnvError(
  parsedValue: unknown,
  error: z.ZodError,
): never {
  const issue = error.issues[0];
  const [indexCandidate, fieldCandidate, nestedCandidate] = issue?.path ?? [];

  if (typeof indexCandidate !== "number") {
    throw createInvalidEnvError(
      parsedValue,
      "MDCMS_AUTH_OIDC_PROVIDERS must be a JSON array.",
    );
  }

  const index = indexCandidate;

  if (fieldCandidate === undefined) {
    throw createInvalidEnvError(
      readIssueValue(parsedValue, [index]),
      "Each OIDC provider entry must be an object.",
      { index },
    );
  }

  const field = String(fieldCandidate);
  const issuePath = issue.path.filter(
    (segment): segment is string | number =>
      typeof segment === "string" || typeof segment === "number",
  );
  const issueValue = readIssueValue(parsedValue, issuePath);

  if (field === "providerId") {
    if (issue.code === "invalid_value") {
      throw createInvalidEnvError(issueValue, "providerId is not supported.", {
        field: "providerId",
        index,
      });
    }

    if (issue.code === "custom") {
      throw createInvalidEnvError(issueValue, issue.message, {
        field: "providerId",
        index,
      });
    }

    throw createInvalidEnvError(
      issueValue,
      "providerId must be a non-empty string.",
      {
        field: "providerId",
        index,
      },
    );
  }

  if (field === "domain") {
    if (issue.code === "custom") {
      throw createInvalidEnvError(issueValue, issue.message, {
        field: "domain",
        index,
      });
    }

    throw createInvalidEnvError(
      issueValue,
      "domain must be a non-empty string.",
      {
        field: "domain",
        index,
      },
    );
  }

  if (field === "issuer") {
    const message = isNonEmptyStringIssue(issue)
      ? "issuer must be a non-empty string."
      : "issuer must be an absolute URL.";

    throw createInvalidEnvError(issueValue, message, {
      field: "issuer",
      index,
    });
  }

  if (field === "clientId" || field === "clientSecret") {
    throw createInvalidEnvError(
      issueValue,
      `${field} must be a non-empty string.`,
      {
        field,
        index,
      },
    );
  }

  if (field === "scopes") {
    if (issue.path.length >= 3) {
      throw createInvalidEnvError(
        issueValue,
        "scopes must be a non-empty string.",
        {
          field: "scopes",
          index,
        },
      );
    }

    const message =
      issue.code === "too_small"
        ? "scopes must not be empty."
        : "scopes must be an array of strings.";

    throw createInvalidEnvError(
      readIssueValue(parsedValue, [index, "scopes"]),
      message,
      {
        field: "scopes",
        index,
      },
    );
  }

  if (field === "trustedOrigins") {
    if (issue.path.length >= 3) {
      const message = isNonEmptyStringIssue(issue)
        ? "trustedOrigins must be a non-empty string."
        : "trustedOrigins must be an absolute origin in scheme://host[:port] form.";

      throw createInvalidEnvError(issueValue, message, {
        field: "trustedOrigins",
        index,
      });
    }

    throw createInvalidEnvError(
      readIssueValue(parsedValue, [index, "trustedOrigins"]),
      "trustedOrigins must be an array of absolute origins.",
      {
        field: "trustedOrigins",
        index,
      },
    );
  }

  if (field === "discoveryOverrides") {
    if (issue.code === "invalid_type" && issue.path.length === 2) {
      throw createInvalidEnvError(
        readIssueValue(parsedValue, [index, "discoveryOverrides"]),
        "discoveryOverrides must be an object when provided.",
        {
          field: "discoveryOverrides",
          index,
        },
      );
    }

    if (issue.code === "unrecognized_keys" && issue.keys[0]) {
      throw createInvalidEnvError(
        readIssueValue(parsedValue, [index, "discoveryOverrides"]),
        `discoveryOverrides.${issue.keys[0]} is not supported.`,
        {
          field: "discoveryOverrides",
          index,
          overrideKey: issue.keys[0],
        },
      );
    }

    if (nestedCandidate === "tokenEndpointAuthMethod") {
      throw createInvalidEnvError(
        issueValue,
        "discoveryOverrides.tokenEndpointAuthMethod must be client_secret_basic or client_secret_post.",
        {
          field: "discoveryOverrides.tokenEndpointAuthMethod",
          index,
        },
      );
    }

    if (typeof nestedCandidate === "string") {
      const fieldPath = `discoveryOverrides.${nestedCandidate}`;
      const message = isNonEmptyStringIssue(issue)
        ? `${fieldPath} must be a non-empty string.`
        : `${fieldPath} must be an absolute URL.`;

      throw createInvalidEnvError(issueValue, message, {
        field: fieldPath,
        index,
      });
    }
  }

  throw createInvalidEnvError(
    readIssueValue(parsedValue, [index]),
    "Each OIDC provider entry must be an object.",
    { index },
  );
}

function throwSamlProvidersEnvError(
  parsedValue: unknown,
  error: z.ZodError,
): never {
  const issue = error.issues[0];
  const [indexCandidate, fieldCandidate, nestedCandidate] = issue?.path ?? [];

  if (typeof indexCandidate !== "number") {
    throw createSamlInvalidEnvError(
      parsedValue,
      "MDCMS_AUTH_SAML_PROVIDERS must be a JSON array.",
    );
  }

  const index = indexCandidate;

  if (fieldCandidate === undefined) {
    throw createSamlInvalidEnvError(
      readIssueValue(parsedValue, [index]),
      "Each SAML provider entry must be an object.",
      { index },
    );
  }

  const field = String(fieldCandidate);
  const issuePath = issue.path.filter(
    (segment): segment is string | number =>
      typeof segment === "string" || typeof segment === "number",
  );
  const issueValue = readIssueValue(parsedValue, issuePath);

  if (field === "providerId" || field === "domain") {
    if (issue.code === "custom") {
      throw createSamlInvalidEnvError(issueValue, issue.message, {
        field,
        index,
      });
    }

    throw createSamlInvalidEnvError(
      issueValue,
      `${field} must be a non-empty string.`,
      {
        field,
        index,
      },
    );
  }

  if (
    field === "issuer" ||
    field === "cert" ||
    field === "audience" ||
    field === "spEntityId" ||
    field === "identifierFormat"
  ) {
    throw createSamlInvalidEnvError(
      issueValue,
      `${field} must be a non-empty string.`,
      {
        field,
        index,
      },
    );
  }

  if (field === "entryPoint") {
    const message = isNonEmptyStringIssue(issue)
      ? "entryPoint must be a non-empty string."
      : "entryPoint must be an absolute URL.";

    throw createSamlInvalidEnvError(issueValue, message, {
      field: "entryPoint",
      index,
    });
  }

  if (field === "authnRequestsSigned" || field === "wantAssertionsSigned") {
    throw createSamlInvalidEnvError(
      issueValue,
      `${field} must be a boolean when provided.`,
      {
        field,
        index,
      },
    );
  }

  if (field === "attributeMapping") {
    if (issue.code === "invalid_type" && issue.path.length === 2) {
      throw createSamlInvalidEnvError(
        readIssueValue(parsedValue, [index, "attributeMapping"]),
        "attributeMapping must be an object when provided.",
        {
          field: "attributeMapping",
          index,
        },
      );
    }

    if (issue.code === "unrecognized_keys" && issue.keys[0]) {
      throw createSamlInvalidEnvError(
        readIssueValue(parsedValue, [index, "attributeMapping"]),
        `attributeMapping.${issue.keys[0]} is not supported.`,
        {
          field: "attributeMapping",
          index,
          attribute: issue.keys[0],
        },
      );
    }

    if (typeof nestedCandidate === "string") {
      throw createSamlInvalidEnvError(
        issueValue,
        `attributeMapping.${nestedCandidate} must be a non-empty string.`,
        {
          field: `attributeMapping.${nestedCandidate}`,
          index,
        },
      );
    }
  }

  throw createSamlInvalidEnvError(
    readIssueValue(parsedValue, [index]),
    "Each SAML provider entry must be an object.",
    { index },
  );
}

function parseOidcProviders(
  rawValue: string | undefined,
): OidcProviderConfig[] {
  const resolvedValue = rawValue?.trim();

  if (!resolvedValue) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(resolvedValue);
  } catch {
    throw createInvalidEnvError(
      rawValue,
      "MDCMS_AUTH_OIDC_PROVIDERS must be valid JSON.",
    );
  }

  const validated = OidcProvidersSchema.safeParse(parsed);

  if (validated.success) {
    return validated.data;
  }

  return throwOidcProvidersEnvError(parsed, validated.error);
}

function parseSamlProviders(
  rawValue: string | undefined,
): SamlProviderConfig[] {
  const resolvedValue = rawValue?.trim();

  if (!resolvedValue) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(resolvedValue);
  } catch {
    throw createSamlInvalidEnvError(
      rawValue,
      "MDCMS_AUTH_SAML_PROVIDERS must be valid JSON.",
    );
  }

  const validated = SamlProvidersSchema.safeParse(parsed);

  if (validated.success) {
    return validated.data;
  }

  return throwSamlProvidersEnvError(parsed, validated.error);
}

function assertUniqueSsoProviderIds(
  oidcProviders: OidcProviderConfig[],
  samlProviders: SamlProviderConfig[],
): void {
  const providerIds = new Set<string>(
    oidcProviders.map((provider) => provider.providerId),
  );

  for (const provider of samlProviders) {
    if (providerIds.has(provider.providerId)) {
      throw createSamlInvalidEnvError(
        provider.providerId,
        `providerId ${provider.providerId} must be unique across OIDC and SAML.`,
        {
          field: "providerId",
          providerId: provider.providerId,
        },
      );
    }

    providerIds.add(provider.providerId);
  }
}

/**
 * parseServerEnv extends the shared core runtime env with server-specific
 * settings used for health and request handling.
 */
export function parseServerEnv(rawEnv: NodeJS.ProcessEnv): ServerEnv {
  const core = parseCoreEnv(rawEnv);
  const parsedExtension = ServerEnvExtensionSchema.safeParse(rawEnv);

  if (!parsedExtension.success) {
    const fieldErrors = parsedExtension.error.flatten().fieldErrors;
    const failingKeys = Object.keys(fieldErrors);
    if (failingKeys.length === 1 && failingKeys[0] === "PORT") {
      return throwInvalidPortEnvError(rawEnv.PORT);
    }
    throw new RuntimeError({
      code: "INVALID_ENV",
      message: `Invalid server environment variable(s): ${failingKeys.join(", ")}. ${parsedExtension.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      details: {
        keys: failingKeys,
        issues: parsedExtension.error.issues,
      },
    });
  }

  const oidcProviders = parseOidcProviders(rawEnv.MDCMS_AUTH_OIDC_PROVIDERS);
  const samlProviders = parseSamlProviders(rawEnv.MDCMS_AUTH_SAML_PROVIDERS);
  const studioAllowedOrigins = parseStudioAllowedOrigins(
    rawEnv.MDCMS_STUDIO_ALLOWED_ORIGINS,
  );
  const studioRuntimeDisabled = parseStudioRuntimeDisabledFlag(
    rawEnv.MDCMS_STUDIO_RUNTIME_DISABLED,
  );
  assertUniqueSsoProviderIds(oidcProviders, samlProviders);

  return extendEnv(core, () => ({
    ...parsedExtension.data,
    MDCMS_STUDIO_RUNTIME_DISABLED: studioRuntimeDisabled,
    MDCMS_AUTH_OIDC_PROVIDERS: oidcProviders,
    MDCMS_AUTH_SAML_PROVIDERS: samlProviders,
    MDCMS_STUDIO_ALLOWED_ORIGINS: studioAllowedOrigins,
  }));
}
