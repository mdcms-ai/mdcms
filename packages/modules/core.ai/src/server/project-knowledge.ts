import type {
  MdxComponentCatalog,
  SchemaRegistryFieldSnapshot,
  SchemaRegistryTypeSnapshot,
} from "@mdcms/shared";

export type ProjectKnowledgeInput = {
  project: string;
  environment: string;
  registeredTypes: SchemaRegistryTypeSnapshot[];
  supportedLocales: string[];
  currentUser?: { id: string; displayName: string };
  mdxCatalog?: MdxComponentCatalog;
};

/**
 * Renders the per-turn "Project knowledge" block injected into the
 * chat system prompt. Pure function; safe to snapshot.
 */
export function renderProjectKnowledgeBlock(
  input: ProjectKnowledgeInput,
): string {
  const lines: string[] = [
    "## Project knowledge",
    "",
    `Project: ${sanitizeForPrompt(input.project)}`,
    `Environment: ${sanitizeForPrompt(input.environment)}`,
  ];

  if (input.currentUser) {
    lines.push(
      `Current user: ${sanitizeUserText(input.currentUser.displayName)} (id: ${sanitizeForPrompt(input.currentUser.id)})`,
    );
  }

  lines.push("");

  if (input.registeredTypes.length === 0) {
    lines.push(
      "No content types are registered yet — propose_create_document will fail until at least one is synced.",
    );
  } else {
    lines.push(
      "### Content types registered in this project",
      "Use these exact `type` ids when calling propose_create_document. Anything else will fail validation. Path prefixes are conventions, not enforced.",
      "",
    );
    const sortedTypes = [...input.registeredTypes].sort((a, b) =>
      a.type.localeCompare(b.type),
    );
    let hasReferenceField = false;
    for (const schema of sortedTypes) {
      lines.push(...renderTypeEntry(schema));
      lines.push("");
      if (!hasReferenceField && schemaContainsReference(schema)) {
        hasReferenceField = true;
      }
    }
    if (hasReferenceField) {
      lines.push(
        "### Reference fields require real entry ids",
        "When a field is `reference → <type>`, fill it with the documentId of an entry that already exists in this project. Use the `find_entries` tool to look up candidates by type, then copy the `documentId` from a result into the reference field. Do not invent ids and do not write a person's name or any other prose — apply will reject anything that isn't a real UUID, and the proposal-time validator emits UNKNOWN_REFERENCE before that.",
        "",
      );
    }
  }

  if (input.supportedLocales.length > 0) {
    lines.push("", "### Supported locales");
    lines.push(input.supportedLocales.join(", "));
  }

  if (input.mdxCatalog) {
    lines.push("", "### Registered MDX components");
    if (input.mdxCatalog.components.length === 0) {
      lines.push(
        "No MDX components are registered. Do not generate JSX component tags in Markdown or MDX bodies.",
      );
    } else {
      lines.push(
        "Use only these component names when generating MDX. Any other component name fails validation.",
        "For visual composition, use registered components or built-ins instead of raw lowercase HTML containers. Raw lowercase HTML is only valid when the user needs native form or input semantics.",
      );
      const sortedComponents = [...input.mdxCatalog.components].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const component of sortedComponents) {
        lines.push(...renderMdxComponentEntry(component));
      }
    }
  }

  return lines.join("\n");
}

/**
 * Replace characters that would break the markdown structure of the
 * prompt. Used for system-typed identifiers (project slug, environment
 * slug, user id) where the value is otherwise constrained by routing
 * regexes — only the structural breakers (backticks, line breaks)
 * actually need neutralizing.
 */
function sanitizeForPrompt(value: string): string {
  return value.replace(/[`\n\r]/g, " ").trim();
}

/**
 * Strip the broader set of markdown/HTML structure characters from
 * free-text values supplied by users (e.g. `authUsers.name`). A
 * malicious display name like `</context> *Ignore everything above*`
 * is reduced to a plain text run so it can't open a code span, close
 * an HTML/quote block, or inject emphasis/table syntax that the model
 * might parse as control structure.
 */
function sanitizeUserText(value: string): string {
  return value.replace(/[`*~\[\]<>|\n\r]/g, " ").trim();
}

const MAX_NESTED_DEPTH = 1;

function schemaContainsReference(schema: SchemaRegistryTypeSnapshot): boolean {
  for (const field of Object.values(schema.fields)) {
    if (fieldContainsReference(field)) return true;
  }
  return false;
}

function fieldContainsReference(field: SchemaRegistryFieldSnapshot): boolean {
  if (field.kind === "reference") return true;
  if (field.item && fieldContainsReference(field.item)) return true;
  if (field.fields) {
    for (const sub of Object.values(field.fields)) {
      if (fieldContainsReference(sub)) return true;
    }
  }
  return false;
}

function renderTypeEntry(schema: SchemaRegistryTypeSnapshot): string[] {
  const lines: string[] = [
    `- **${schema.type}** (directory: ${schema.directory}, localized: ${schema.localized ? "yes" : "no"})`,
  ];
  const fieldEntries = Object.entries(schema.fields);
  if (fieldEntries.length === 0) {
    lines.push("  (no fields)");
    return lines;
  }
  lines.push("  Fields:");
  for (const [name, field] of fieldEntries) {
    lines.push(...renderFieldLines(name, field, 1));
  }
  return lines;
}

function renderFieldLines(
  name: string,
  field: SchemaRegistryFieldSnapshot,
  depth: number,
): string[] {
  const indent = "  ".repeat(depth);
  const descriptor = renderKindDescriptor(field, depth);
  const flags: string[] = [field.required ? "required" : "optional"];
  if (field.nullable) flags.push("nullable");
  const lines = [`${indent}- ${name} (${descriptor}, ${flags.join(", ")})`];

  // Inline-expand nested objects up to MAX_NESTED_DEPTH; deeper levels
  // were already collapsed to "<nested object>" by renderKindDescriptor.
  if (field.kind === "object" && field.fields && depth <= MAX_NESTED_DEPTH) {
    for (const [subName, subField] of Object.entries(field.fields)) {
      lines.push(...renderFieldLines(subName, subField, depth + 1));
    }
  }

  return lines;
}

function renderKindDescriptor(
  field: SchemaRegistryFieldSnapshot,
  depth: number,
): string {
  if (field.kind === "enum" && field.options) {
    const formatted = field.options
      .map((option) => JSON.stringify(option))
      .join(" | ");
    return `enum: ${formatted}`;
  }
  if (field.kind === "reference" && field.reference) {
    return `reference → ${field.reference.targetType}`;
  }
  if (field.kind === "array" && field.item) {
    return `array of ${renderKindDescriptor(field.item, depth)}`;
  }
  if (field.kind === "object" && depth > MAX_NESTED_DEPTH) {
    return "<nested object> — call get_entry on a sibling for the full shape";
  }
  return field.kind;
}

function renderMdxComponentEntry(
  component: MdxComponentCatalog["components"][number],
): string[] {
  const lines = [`- **${sanitizeForPrompt(component.name)}**`];
  if (component.builtIn) {
    lines[0] += " (built-in)";
  }
  if (component.description) {
    lines[0] += ` — ${sanitizeUserText(component.description)}`;
  }

  const propEntries = Object.entries(component.extractedProps ?? {});
  if (propEntries.length === 0) {
    lines.push("  Props: none declared.");
    return lines;
  }

  lines.push("  Props:");
  for (const [name, prop] of propEntries) {
    const detail =
      prop.type === "enum"
        ? `enum ${prop.values.map((value) => JSON.stringify(value)).join(" | ")}`
        : prop.type === "array"
          ? `array of ${prop.items}`
          : prop.type;
    const flags = prop.required ? "required" : "optional";
    lines.push(`  - ${sanitizeForPrompt(name)} (${detail}, ${flags})`);
  }
  return lines;
}
