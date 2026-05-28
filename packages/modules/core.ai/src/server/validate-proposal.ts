import type {
  AiProposalCandidate,
  AiProposalValidator,
} from "./proposal-builder.js";
import type {
  AiProposalValidation,
  MdxComponentCatalog,
  MdxExtractedProp,
  SchemaRegistryFieldSnapshot,
  SchemaRegistryTypeSnapshot,
} from "@mdcms/shared";
import { fromMarkdown } from "mdast-util-from-markdown";
import { mdxFromMarkdown } from "mdast-util-mdx";
import { mdx } from "micromark-extension-mdx";

/**
 * Looks up a content type's schema for a given project + environment.
 * Returns `undefined` when the type isn't registered in the project,
 * which lets the validator emit `UNKNOWN_CONTENT_TYPE` instead of
 * throwing. The caller (the factory below) wraps a real DB-backed
 * lookup; the unit-test path passes an in-memory map.
 */
export type SchemaLookup = (input: {
  project: string;
  environment: string;
  type: string;
}) => Promise<SchemaRegistryTypeSnapshot | undefined>;

/**
 * Returns true when a non-deleted document already exists at the
 * given path within the project + environment. Used by the
 * create_document validator to flag `PATH_ALREADY_IN_USE` proposals.
 */
export type PathLookup = (input: {
  project: string;
  environment: string;
  path: string;
}) => Promise<boolean>;

/**
 * Returns true when a non-deleted document with the given documentId
 * exists in the project + environment. Used by the reference-field
 * validator to flag `UNKNOWN_REFERENCE` proposals.
 */
export type DocumentLookup = (input: {
  project: string;
  environment: string;
  documentId: string;
}) => Promise<boolean>;

/**
 * Construct a schema-aware proposal validator that gets wired into
 * the AI orchestrator. The validator catches three categories of
 * issue at proposal time so the Studio card surfaces them before the
 * user clicks Accept:
 *
 *   1. `UNKNOWN_CONTENT_TYPE` — the proposal's `type` isn't a content
 *      type registered for the project + environment.
 *   2. `MISSING_REQUIRED_FRONTMATTER` — the schema marks a field as
 *      required and the proposal's frontmatter doesn't include it.
 *   3. `UNKNOWN_FRONTMATTER_FIELD` — the proposal's frontmatter
 *      includes a key the schema doesn't define.
 *   4. `INVALID_FRONTMATTER_TYPE` — a frontmatter value's runtime kind
 *      doesn't match the schema field's declared `kind` (e.g. a
 *      string field receiving a number).
 *
 * Replace-selection body-anchor validation is layered in per active
 * document by `createReplaceSelectionApplyabilityValidator`, because
 * the current draft body is turn-specific rather than schema state.
 * MDX-bearing operations are parsed here with the same parser family
 * as Studio so syntax-invalid proposals cannot be marked valid.
 */
export function createSchemaAwareProposalValidator(input: {
  schemaLookup: SchemaLookup;
  pathExists?: PathLookup;
  documentExists?: DocumentLookup;
}): AiProposalValidator {
  const { schemaLookup, pathExists, documentExists } = input;

  return async (
    candidate: AiProposalCandidate,
  ): Promise<AiProposalValidation> => {
    switch (candidate.kind) {
      case "create_document":
        return mergeValidation(
          await validateCreateDocument(
            candidate,
            schemaLookup,
            pathExists,
            documentExists,
          ),
          validateMdxTargetsAgainstStudioParser(collectMdxTargets(candidate)),
        );
      case "update_frontmatter":
        return validateUpdateFrontmatter(
          candidate,
          schemaLookup,
          documentExists,
        );
      case "delete_document":
      case "replace_selection":
      case "insert_block":
        // delete_document's published-version
        // check is already done by chat-tools at proposal-build time
        // and re-enforced by apply.ts at apply time. replace_selection
        // anchor checks and MDX catalog checks are layered separately.
        return validationFromErrors(
          validateMdxTargetsAgainstStudioParser(collectMdxTargets(candidate)),
        );
    }
  };
}

type ValidationError = {
  code: string;
  message: string;
  path?: string;
};

type MdxValidationTarget = {
  source: string;
  path: string;
};

type MdxTag = {
  name: string;
  attrs: Record<string, MdxAttributeValue>;
  selfClosing: boolean;
};

type MdxAttributeValue =
  | { kind: "boolean"; value: boolean }
  | { kind: "string"; value: string }
  | { kind: "expression"; value: string };

export function createReplaceSelectionApplyabilityValidator(input: {
  validator?: AiProposalValidator;
  body: string;
}): AiProposalValidator {
  const { validator, body } = input;

  return async (candidate) => {
    const base = validator
      ? await validator(candidate)
      : ({ status: "valid" } satisfies AiProposalValidation);
    const errors = validateReplaceSelectionAgainstBody(candidate, body);
    return mergeValidation(base, errors);
  };
}

function validateReplaceSelectionAgainstBody(
  candidate: AiProposalCandidate,
  body: string,
): ValidationError[] {
  if (candidate.kind !== "replace_selection") return [];

  const errors: ValidationError[] = [];
  candidate.operations.forEach((operation, index) => {
    if (operation.op !== "replace_selection") return;

    const first = body.indexOf(operation.originalText);
    if (first < 0) {
      errors.push({
        code: "REPLACE_SELECTION_SOURCE_NOT_FOUND",
        message:
          "Original selection text was not found in the current draft body.",
        path: `operations[${index}].originalText`,
      });
      return;
    }

    if (first !== body.lastIndexOf(operation.originalText)) {
      errors.push({
        code: "REPLACE_SELECTION_SOURCE_AMBIGUOUS",
        message:
          "Original selection text appears more than once in the current draft body; refusing to apply ambiguously.",
        path: `operations[${index}].originalText`,
      });
    }
  });

  return errors;
}

function mergeValidation(
  base: AiProposalValidation,
  errors: ValidationError[],
): AiProposalValidation {
  if (errors.length === 0) return base;
  if (base.status === "invalid") {
    return { status: "invalid", errors: [...base.errors, ...errors] };
  }
  return { status: "invalid", errors };
}

function validationFromErrors(errors: ValidationError[]): AiProposalValidation {
  return errors.length === 0
    ? { status: "valid" }
    : { status: "invalid", errors };
}

function validateMdxTargetsAgainstStudioParser(
  targets: readonly MdxValidationTarget[],
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const target of targets) {
    try {
      fromMarkdown(target.source, {
        extensions: [mdx()],
        mdastExtensions: [mdxFromMarkdown()],
      });
    } catch (error) {
      errors.push({
        code: "MDX_PARSE_FAILED",
        message: formatMdxParseFailure(error),
        path: target.path,
      });
    }
  }

  return errors;
}

function formatMdxParseFailure(error: unknown): string {
  const reason =
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    typeof error.reason === "string"
      ? error.reason
      : error instanceof Error && error.message
        ? error.message
        : "Unknown MDX parse error.";
  const place =
    typeof error === "object" && error !== null && "place" in error
      ? error.place
      : undefined;
  const line =
    typeof place === "object" &&
    place !== null &&
    "line" in place &&
    typeof place.line === "number"
      ? place.line
      : undefined;
  const column =
    typeof place === "object" &&
    place !== null &&
    "column" in place &&
    typeof place.column === "number"
      ? place.column
      : undefined;

  if (typeof line === "number" && typeof column === "number") {
    return `Generated MDX failed Studio MDX parser validation at line ${line}, column ${column}: ${reason}`;
  }

  return `Generated MDX failed Studio MDX parser validation: ${reason}`;
}

/** RFC4122-ish UUID literal — mirrors the apply-time check in `reference-validation.ts`. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Wrap an existing proposal validator with MDX component-catalog
 * validation. The base validator remains responsible for content type,
 * frontmatter, path, and reference checks; this layer rejects generated
 * MDX that cannot be grounded in Studio's active host-supplied catalog.
 */
export function createMdxCatalogProposalValidator(input: {
  validator?: AiProposalValidator;
  catalog: MdxComponentCatalog;
}): AiProposalValidator {
  const { validator, catalog } = input;

  return async (candidate) => {
    const base = validator
      ? await validator(candidate)
      : ({ status: "valid" } satisfies AiProposalValidation);
    const mdxErrors = validateMdxTargetsAgainstCatalog(
      collectMdxTargets(candidate),
      catalog,
    );

    if (mdxErrors.length === 0) {
      return base;
    }

    if (base.status === "invalid") {
      return {
        status: "invalid",
        errors: [...base.errors, ...mdxErrors],
      };
    }

    return { status: "invalid", errors: mdxErrors };
  };
}

async function validateCreateDocument(
  candidate: AiProposalCandidate,
  schemaLookup: SchemaLookup,
  pathExists: PathLookup | undefined,
  documentExists: DocumentLookup | undefined,
): Promise<AiProposalValidation> {
  const errors: ValidationError[] = [];

  const schema = await schemaLookup({
    project: candidate.project,
    environment: candidate.environment,
    type: candidate.type,
  });

  if (!schema) {
    errors.push({
      code: "UNKNOWN_CONTENT_TYPE",
      message: `Content type "${candidate.type}" is not registered in this project. Pick a type that matches a schema in the project (e.g. from the path's leading segment).`,
      path: "type",
    });
    // No further per-field checks possible without a schema — return
    // early with just the type error so the card is actionable.
    return { status: "invalid", errors };
  }

  // Find the operation. create_document proposals carry exactly one.
  const operation = candidate.operations[0];
  if (!operation || operation.op !== "create_document") {
    // Defensive — buildProposalsFromOutput already guarantees this
    // shape, but a corrupt candidate shouldn't crash the validator.
    return {
      status: "invalid",
      errors: [
        {
          code: "INVALID_OPERATION",
          message: "create_document proposal is missing its operation.",
        },
      ],
    };
  }

  const frontmatter = operation.frontmatter ?? {};
  validateFrontmatterAgainstSchema(frontmatter, schema, errors);

  if (pathExists) {
    const taken = await pathExists({
      project: candidate.project,
      environment: candidate.environment,
      path: operation.path,
    });
    if (taken) {
      errors.push({
        code: "PATH_ALREADY_IN_USE",
        message: `Path "${operation.path}" is already used by another document — pick a different path or update the existing doc instead.`,
        path: "operations[0].path",
      });
    }
  }

  if (documentExists) {
    for (const [fieldName, field] of Object.entries(schema.fields)) {
      const refErrors = await collectReferenceErrors({
        value: frontmatter[fieldName],
        field,
        fieldPath: `frontmatter.${fieldName}`,
        project: candidate.project,
        environment: candidate.environment,
        documentExists,
      });
      errors.push(...refErrors);
    }
  }

  return errors.length === 0
    ? { status: "valid" }
    : { status: "invalid", errors };
}

async function validateUpdateFrontmatter(
  candidate: AiProposalCandidate,
  schemaLookup: SchemaLookup,
  documentExists: DocumentLookup | undefined,
): Promise<AiProposalValidation> {
  const errors: ValidationError[] = [];

  const schema = await schemaLookup({
    project: candidate.project,
    environment: candidate.environment,
    type: candidate.type,
  });

  if (!schema) {
    errors.push({
      code: "UNKNOWN_CONTENT_TYPE",
      message: `Content type "${candidate.type}" is not registered in this project.`,
      path: "type",
    });
    return { status: "invalid", errors };
  }

  const operation = candidate.operations[0];
  if (!operation || operation.op !== "update_frontmatter") {
    return {
      status: "invalid",
      errors: [
        {
          code: "INVALID_OPERATION",
          message: "update_frontmatter proposal is missing its operation.",
        },
      ],
    };
  }

  // Update is a shallow-merge patch: validate each key in the patch
  // is a known field and each value has the right shape. We do NOT
  // check `required` on update — the existing draft already has
  // those filled (or it would have failed create validation).
  for (const [key, value] of Object.entries(operation.patch)) {
    const field = schema.fields[key];
    if (!field) {
      errors.push({
        code: "UNKNOWN_FRONTMATTER_FIELD",
        message: `Field "${key}" is not defined in the "${schema.type}" schema.`,
        path: `patch.${key}`,
      });
      continue;
    }
    const typeError = checkFieldType(key, value, field, `patch.${key}`);
    if (typeError) errors.push(typeError);
  }

  if (documentExists) {
    for (const [key, value] of Object.entries(operation.patch)) {
      const field = schema.fields[key];
      if (!field) continue; // already flagged as UNKNOWN_FRONTMATTER_FIELD
      const refErrors = await collectReferenceErrors({
        value,
        field,
        fieldPath: `patch.${key}`,
        project: candidate.project,
        environment: candidate.environment,
        documentExists,
      });
      errors.push(...refErrors);
    }
  }

  return errors.length === 0
    ? { status: "valid" }
    : { status: "invalid", errors };
}

function validateFrontmatterAgainstSchema(
  frontmatter: Record<string, unknown>,
  schema: SchemaRegistryTypeSnapshot,
  errors: ValidationError[],
): void {
  // Missing required fields
  for (const [fieldName, field] of Object.entries(schema.fields)) {
    if (!field.required) continue;
    if (!(fieldName in frontmatter) || frontmatter[fieldName] === undefined) {
      errors.push({
        code: "MISSING_REQUIRED_FRONTMATTER",
        message: `Required field "${fieldName}" is missing from frontmatter.`,
        path: `frontmatter.${fieldName}`,
      });
    }
  }

  // Unknown fields + value-shape checks
  for (const [key, value] of Object.entries(frontmatter)) {
    const field = schema.fields[key];
    if (!field) {
      errors.push({
        code: "UNKNOWN_FRONTMATTER_FIELD",
        message: `Field "${key}" is not defined in the "${schema.type}" schema.`,
        path: `frontmatter.${key}`,
      });
      continue;
    }
    const typeError = checkFieldType(key, value, field, `frontmatter.${key}`);
    if (typeError) errors.push(typeError);
  }
}

async function collectReferenceErrors(input: {
  value: unknown;
  field: SchemaRegistryFieldSnapshot;
  fieldPath: string;
  project: string;
  environment: string;
  documentExists: DocumentLookup;
}): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];
  await walkReferences(input, errors);
  return errors;
}

async function walkReferences(
  input: {
    value: unknown;
    field: SchemaRegistryFieldSnapshot;
    fieldPath: string;
    project: string;
    environment: string;
    documentExists: DocumentLookup;
  },
  errors: ValidationError[],
): Promise<void> {
  const { value, field, fieldPath, project, environment, documentExists } =
    input;

  if (value === null || value === undefined) return;

  if (field.reference && field.kind === "reference") {
    if (typeof value !== "string") {
      // Wrong-type errors are emitted by checkFieldType elsewhere.
      return;
    }
    // Fast-path: reference values must look like a documentId (UUID).
    // The model occasionally writes a display name (e.g. "Demo User")
    // into a reference field; without this guard we'd hand a non-UUID
    // to a uuid-typed column lookup, which either crashes the
    // validator or — depending on the driver — silently returns no
    // rows and gets reported as "doc not found" rather than what it
    // actually is (a malformed reference). Mirrors the apply-time
    // check in `apps/server/src/lib/content-api/reference-validation.ts`.
    if (!UUID_PATTERN.test(value)) {
      errors.push({
        code: "UNKNOWN_REFERENCE",
        message: `Field "${fieldPath.replace(/^frontmatter\./, "")}" must be a UUID string referencing "${field.reference.targetType}". Use the find_entries tool to look up a real document id; "${value}" is not a valid documentId.`,
        path: fieldPath,
      });
      return;
    }
    let exists = false;
    try {
      exists = await documentExists({
        project,
        environment,
        documentId: value,
      });
    } catch {
      // Treat lookup failures as "doesn't exist" so a transient DB
      // error or driver-level type coercion doesn't crash the whole
      // validator. The UNKNOWN_REFERENCE error below is still the
      // right surface — the model needs to try a different id.
      exists = false;
    }
    if (!exists) {
      errors.push({
        code: "UNKNOWN_REFERENCE",
        message: `Field "${fieldPath.replace(/^frontmatter\./, "")}" references documentId "${value}" which does not exist in this project.`,
        path: fieldPath,
      });
    }
    return;
  }

  if (field.kind === "array" && field.item && Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      await walkReferences(
        {
          value: value[index],
          field: field.item,
          fieldPath: `${fieldPath}[${index}]`,
          project,
          environment,
          documentExists,
        },
        errors,
      );
    }
    return;
  }

  if (
    field.kind === "object" &&
    field.fields &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value !== null
  ) {
    const obj = value as Record<string, unknown>;
    for (const [subName, subField] of Object.entries(field.fields)) {
      await walkReferences(
        {
          value: obj[subName],
          field: subField,
          fieldPath: `${fieldPath}.${subName}`,
          project,
          environment,
          documentExists,
        },
        errors,
      );
    }
    return;
  }
}

function checkFieldType(
  fieldName: string,
  value: unknown,
  field: SchemaRegistryFieldSnapshot,
  path: string,
): ValidationError | undefined {
  if (value === null) {
    if (field.nullable) return undefined;
    return {
      code: "INVALID_FRONTMATTER_TYPE",
      message: `Field "${fieldName}" is not nullable but received null.`,
      path,
    };
  }
  if (value === undefined) {
    // Undefined for an optional field is OK; the missing-required pass
    // above already caught the required case.
    return undefined;
  }
  const actual = jsKindOf(value);
  const expected = expectedJsKind(field);
  if (!expected) {
    // Unknown schema kind — don't reject; let it through. New schema
    // kinds added later shouldn't false-positive existing proposals.
    return undefined;
  }
  if (actual !== expected) {
    return {
      code: "INVALID_FRONTMATTER_TYPE",
      message: `Field "${fieldName}" expects ${expected} (schema kind "${field.kind}") but received ${actual}.`,
      path,
    };
  }
  return undefined;
}

/**
 * Map of schema-kind → expected JS-runtime kind. Returns `undefined`
 * for schema kinds we don't have a checkable runtime mapping for —
 * those slip through validation (intentional: unknown kinds are
 * forwards-compatible).
 */
function expectedJsKind(
  field: SchemaRegistryFieldSnapshot,
): string | undefined {
  switch (field.kind) {
    case "string":
    case "richText":
    case "url":
    case "slug":
    case "markdown":
    case "color":
    case "image":
      return "string";
    case "number":
    case "integer":
    case "float":
      return "number";
    case "boolean":
      return "boolean";
    case "date":
    case "datetime":
      // Dates land as ISO strings in MDCMS frontmatter.
      return "string";
    case "array":
    case "list":
      return "array";
    case "object":
    case "group":
      return "object";
    case "reference":
      // References serialize as objects (or strings for path-only refs).
      // Don't strict-check until reference shape is locked in.
      return undefined;
    case "enum":
    case "select": {
      // Derive the expected runtime kind from the declared options when
      // they're uniformly typed. Mixed or empty option lists skip the
      // strict check (forwards-compatible with future shapes).
      const options = field.options;
      if (!options || options.length === 0) return undefined;
      if (options.every((o) => typeof o === "string")) return "string";
      if (options.every((o) => typeof o === "number")) return "number";
      return undefined;
    }
    default:
      return undefined;
  }
}

function collectMdxTargets(
  candidate: AiProposalCandidate,
): MdxValidationTarget[] {
  const targets: MdxValidationTarget[] = [];

  candidate.operations.forEach((operation, index) => {
    if (operation.op === "create_document") {
      targets.push({
        source: operation.body,
        path: `operations[${index}].body`,
      });
      return;
    }

    if (operation.op === "insert_block") {
      targets.push({
        source: operation.bodyMdx,
        path: `operations[${index}].bodyMdx`,
      });
      return;
    }

    if (operation.op === "replace_selection") {
      targets.push({
        source: operation.replacementText,
        path: `operations[${index}].replacementText`,
      });
    }
  });

  return targets;
}

function validateMdxTargetsAgainstCatalog(
  targets: readonly MdxValidationTarget[],
  catalog: MdxComponentCatalog,
): ValidationError[] {
  if (targets.length === 0) return [];

  const componentsByName = new Map(
    catalog.components.map((component) => [component.name, component]),
  );
  const errors: ValidationError[] = [];

  for (const target of targets) {
    const tags = extractMdxComponentTags(target.source);
    for (const tag of tags) {
      const component = componentsByName.get(tag.name);
      if (!component) {
        errors.push({
          code: "MDX_UNKNOWN_COMPONENT",
          message: `<${tag.name}> is not registered in the active MDX component catalog.`,
          path: target.path,
        });
        continue;
      }

      const props = component.extractedProps;
      if (!props) {
        continue;
      }

      for (const [propName, propSchema] of Object.entries(props)) {
        if (
          propName === "children" ||
          !propSchema.required ||
          tag.attrs[propName] !== undefined
        ) {
          continue;
        }
        errors.push({
          code: "MDX_MISSING_REQUIRED_PROP",
          message: `<${tag.name}> is missing required prop "${propName}".`,
          path: target.path,
        });
      }

      for (const [propName, attr] of Object.entries(tag.attrs)) {
        const propSchema = props[propName];
        if (!propSchema) {
          errors.push({
            code: "MDX_UNKNOWN_PROP",
            message: `<${tag.name}> includes prop "${propName}" which is not defined in the component catalog.`,
            path: target.path,
          });
          continue;
        }
        const error = validateMdxPropValue(
          tag.name,
          propName,
          attr,
          propSchema,
        );
        if (error) {
          errors.push({ ...error, path: target.path });
        }
      }
    }
  }

  return errors;
}

function extractMdxComponentTags(source: string): MdxTag[] {
  const stripped = stripMarkdownCode(source);
  const tags: MdxTag[] = [];
  let index = 0;

  while (index < stripped.length) {
    const start = stripped.indexOf("<", index);
    if (start < 0) break;

    const next = stripped[start + 1];
    if (
      next === undefined ||
      next === "/" ||
      next === "!" ||
      next === "?" ||
      next === ">"
    ) {
      index = start + 1;
      continue;
    }

    const close = findTagClose(stripped, start + 1);
    if (close < 0) break;

    const raw = stripped.slice(start + 1, close).trim();
    const parsed = parseOpeningMdxTag(raw);
    if (parsed) tags.push(parsed);

    index = close + 1;
  }

  return tags;
}

function stripMarkdownCode(source: string): string {
  const lines = source.split(/\r?\n/);
  let inFence = false;
  const strippedLines = lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return "";
    }
    return inFence ? "" : line;
  });

  return strippedLines.join("\n").replace(/`[^`\n]*`/g, "");
}

function findTagClose(source: string, start: number): number {
  let quote: '"' | "'" | null = null;
  let braceDepth = 0;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const previous = source[index - 1];

    if (quote) {
      if (char === quote && previous !== "\\") quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "{") {
      braceDepth += 1;
      continue;
    }

    if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }

    if (char === ">" && braceDepth === 0) return index;
  }

  return -1;
}

function parseOpeningMdxTag(raw: string): MdxTag | undefined {
  const selfClosing = /\/\s*$/.test(raw);
  const cleaned = selfClosing ? raw.replace(/\/\s*$/, "").trimEnd() : raw;
  const match = /^([A-Za-z][A-Za-z0-9_.-]*)(\s[\s\S]*)?$/.exec(cleaned);
  if (!match) return undefined;

  const name = match[1]!;
  if (!isMdxComponentName(name)) return undefined;

  return {
    name,
    attrs: parseMdxAttributes(match[2] ?? ""),
    selfClosing,
  };
}

function isMdxComponentName(name: string): boolean {
  const [head] = name.split(".");
  return Boolean(head && /^[A-Z]/.test(head));
}

function parseMdxAttributes(raw: string): Record<string, MdxAttributeValue> {
  const attrs: Record<string, MdxAttributeValue> = {};
  let index = 0;

  while (index < raw.length) {
    while (/\s/.test(raw[index] ?? "")) index += 1;
    if (index >= raw.length) break;

    const nameStart = index;
    while (/[A-Za-z0-9_:$.-]/.test(raw[index] ?? "")) index += 1;
    const name = raw.slice(nameStart, index);
    if (!name) break;

    while (/\s/.test(raw[index] ?? "")) index += 1;
    if (raw[index] !== "=") {
      attrs[name] = { kind: "boolean", value: true };
      continue;
    }

    index += 1;
    while (/\s/.test(raw[index] ?? "")) index += 1;
    const parsed = readMdxAttributeValue(raw, index);
    if (!parsed) break;
    attrs[name] = parsed.value;
    index = parsed.nextIndex;
  }

  return attrs;
}

function readMdxAttributeValue(
  raw: string,
  index: number,
):
  | {
      value: MdxAttributeValue;
      nextIndex: number;
    }
  | undefined {
  const first = raw[index];
  if (first === '"' || first === "'") {
    let cursor = index + 1;
    let value = "";
    while (cursor < raw.length) {
      const char = raw[cursor];
      if (char === first && raw[cursor - 1] !== "\\") {
        return {
          value: { kind: "string", value },
          nextIndex: cursor + 1,
        };
      }
      value += char;
      cursor += 1;
    }
    return undefined;
  }

  if (first === "{") {
    let cursor = index + 1;
    let depth = 1;
    let quote: '"' | "'" | null = null;
    let value = "";
    while (cursor < raw.length) {
      const char = raw[cursor];
      const previous = raw[cursor - 1];
      if (quote) {
        if (char === quote && previous !== "\\") quote = null;
        value += char;
        cursor += 1;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        value += char;
        cursor += 1;
        continue;
      }
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          return {
            value: { kind: "expression", value: value.trim() },
            nextIndex: cursor + 1,
          };
        }
      }
      value += char;
      cursor += 1;
    }
    return undefined;
  }

  const start = index;
  while (!/\s/.test(raw[index] ?? "") && raw[index] !== undefined) index += 1;
  return {
    value: { kind: "string", value: raw.slice(start, index) },
    nextIndex: index,
  };
}

function validateMdxPropValue(
  componentName: string,
  propName: string,
  attr: MdxAttributeValue,
  prop: MdxExtractedProp,
): Omit<ValidationError, "path"> | undefined {
  const value = normalizeMdxAttributeValue(attr);
  const actual = jsKindOf(value);

  switch (prop.type) {
    case "string":
    case "date":
      if (typeof value !== "string") {
        return invalidMdxPropType(componentName, propName, prop.type, actual);
      }
      if (prop.type === "date" && Number.isNaN(Date.parse(value))) {
        return {
          code: "MDX_INVALID_PROP_TYPE",
          message: `<${componentName}> prop "${propName}" must be a valid date string.`,
        };
      }
      return undefined;
    case "number":
      return typeof value === "number"
        ? undefined
        : invalidMdxPropType(componentName, propName, "number", actual);
    case "boolean":
      return typeof value === "boolean"
        ? undefined
        : invalidMdxPropType(componentName, propName, "boolean", actual);
    case "enum":
      if (typeof value !== "string" || !prop.values.includes(value)) {
        return {
          code: "MDX_INVALID_PROP_TYPE",
          message: `<${componentName}> prop "${propName}" must be one of: ${prop.values.join(", ")}.`,
        };
      }
      return undefined;
    case "array":
      if (
        !Array.isArray(value) ||
        !value.every((item) => typeof item === prop.items)
      ) {
        return invalidMdxPropType(
          componentName,
          propName,
          `${prop.items}[]`,
          actual,
        );
      }
      return undefined;
    case "style": {
      const styleValue = normalizeMdxStyleAttributeValue(attr);
      return isValidMdxStyleValue(styleValue)
        ? undefined
        : invalidMdxPropType(
            componentName,
            propName,
            "flat style object with string or number values",
            jsKindOf(styleValue),
          );
    }
    case "json":
      return value !== undefined
        ? undefined
        : invalidMdxPropType(componentName, propName, "json", actual);
    case "rich-text":
      return undefined;
  }
}

function isValidMdxStyleValue(value: unknown): boolean {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return false;
  }

  return Object.values(value).every(
    (styleValue) =>
      typeof styleValue === "string" ||
      (typeof styleValue === "number" && Number.isFinite(styleValue)),
  );
}

function normalizeMdxStyleAttributeValue(attr: MdxAttributeValue): unknown {
  const normalized = normalizeMdxAttributeValue(attr);
  if (isValidMdxStyleValue(normalized) || attr.kind !== "expression") {
    return normalized;
  }

  return parseMdxStyleObjectLiteral(attr.value.trim());
}

function parseMdxStyleObjectLiteral(
  expression: string,
): Record<string, string | number> | undefined {
  if (!expression.startsWith("{") || !expression.endsWith("}")) {
    return undefined;
  }

  const style: Record<string, string | number> = {};
  const source = expression.slice(1, -1);
  let index = 0;

  while (index < source.length) {
    index = skipWhitespace(source, index);
    if (index >= source.length) return style;

    const key = readStyleObjectKey(source, index);
    if (!key) return undefined;
    index = skipWhitespace(source, key.nextIndex);

    if (source[index] !== ":") return undefined;
    index = skipWhitespace(source, index + 1);

    const value = readStyleObjectValue(source, index);
    if (!value) return undefined;
    style[key.value] = value.value;
    index = skipWhitespace(source, value.nextIndex);

    if (index >= source.length) return style;
    if (source[index] !== ",") return undefined;
    index += 1;
  }

  return style;
}

function readStyleObjectKey(
  source: string,
  index: number,
): { value: string; nextIndex: number } | undefined {
  const first = source[index];
  if (first === '"' || first === "'") {
    return readQuotedStyleString(source, index);
  }

  const match = /^[$A-Z_a-z][$\w]*/.exec(source.slice(index));
  if (!match) return undefined;

  return {
    value: match[0],
    nextIndex: index + match[0].length,
  };
}

function readStyleObjectValue(
  source: string,
  index: number,
): { value: string | number; nextIndex: number } | undefined {
  const first = source[index];
  if (first === '"' || first === "'") {
    return readQuotedStyleString(source, index);
  }

  const match = /^-?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?/.exec(
    source.slice(index),
  );
  if (!match) return undefined;

  return {
    value: Number(match[0]),
    nextIndex: index + match[0].length,
  };
}

function readQuotedStyleString(
  source: string,
  index: number,
): { value: string; nextIndex: number } | undefined {
  const quote = source[index];
  if (quote !== '"' && quote !== "'") return undefined;

  let cursor = index + 1;
  let value = "";
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === quote && source[cursor - 1] !== "\\") {
      return { value, nextIndex: cursor + 1 };
    }
    value += char;
    cursor += 1;
  }

  return undefined;
}

function skipWhitespace(source: string, index: number): number {
  let cursor = index;
  while (/\s/.test(source[cursor] ?? "")) cursor += 1;
  return cursor;
}

function normalizeMdxAttributeValue(attr: MdxAttributeValue): unknown {
  if (attr.kind === "boolean") return attr.value;
  if (attr.kind === "string") return attr.value;

  const expression = attr.value.trim();
  if (expression === "true") return true;
  if (expression === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(expression)) return Number(expression);
  const stringMatch = /^["']([\s\S]*)["']$/.exec(expression);
  if (stringMatch) return stringMatch[1];
  try {
    return JSON.parse(expression);
  } catch {
    return undefined;
  }
}

function invalidMdxPropType(
  componentName: string,
  propName: string,
  expected: string,
  actual: string,
): Omit<ValidationError, "path"> {
  return {
    code: "MDX_INVALID_PROP_TYPE",
    message: `<${componentName}> prop "${propName}" expects ${expected} but received ${actual}.`,
  };
}

function jsKindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
