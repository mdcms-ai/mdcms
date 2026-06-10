function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

export function isReferenceResolveErrorEntry(
  entry: Record<string, unknown>,
): boolean {
  return (
    (entry.code === "REFERENCE_NOT_FOUND" ||
      entry.code === "REFERENCE_DELETED" ||
      entry.code === "REFERENCE_TYPE_MISMATCH" ||
      entry.code === "REFERENCE_FORBIDDEN") &&
    isRecord(entry.ref) &&
    isString(entry.ref.documentId) &&
    isString(entry.ref.type)
  );
}

export function isMediaResolveErrorEntry(
  entry: Record<string, unknown>,
): boolean {
  if (
    (entry.code !== "MEDIA_NOT_FOUND" &&
      entry.code !== "MEDIA_TYPE_MISMATCH") ||
    !isRecord(entry.media) ||
    !isString(entry.media.assetId)
  ) {
    return false;
  }

  return (
    (entry.media.expectedMime === undefined ||
      isStringArray(entry.media.expectedMime)) &&
    (entry.media.actualMimeType === undefined ||
      isString(entry.media.actualMimeType))
  );
}
