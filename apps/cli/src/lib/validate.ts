import {
  validateFrontmatter,
  type SchemaRegistryTypeSnapshot,
} from "@mdcms/shared";
export { validateFrontmatter, type ValidationResult } from "@mdcms/shared";

export type ValidateCandidate = {
  path: string;
  typeName: string;
  frontmatter: Record<string, unknown>;
};

export type DocumentValidationResult = {
  path: string;
  errors: string[];
  warnings: string[];
};

export function validateCandidates(
  candidates: ValidateCandidate[],
  resolvedSchema: Record<string, SchemaRegistryTypeSnapshot>,
): DocumentValidationResult[] {
  return candidates.map((candidate) => {
    const typeSnapshot = resolvedSchema[candidate.typeName];

    if (!typeSnapshot) {
      return {
        path: candidate.path,
        errors: [
          `Content type "${candidate.typeName}" not found in resolved schema.`,
        ],
        warnings: [],
      };
    }

    const { errors, warnings } = validateFrontmatter(
      candidate.frontmatter,
      typeSnapshot,
    );

    return {
      path: candidate.path,
      errors,
      warnings,
    };
  });
}
