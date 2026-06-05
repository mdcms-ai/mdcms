export function formatClientDate(value: string): string {
  return new Date(value).toLocaleString();
}
