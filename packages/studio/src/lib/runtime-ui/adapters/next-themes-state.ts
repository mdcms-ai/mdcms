export type Theme = "light" | "dark" | "system";
export type AppliedTheme = "light" | "dark";
export type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

export const STUDIO_THEME_STORAGE_KEY = "mdcms-studio-theme";

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

export function readStoredThemePreference(
  storage: ThemeStorage | null | undefined,
): Theme | null {
  if (!storage) {
    return null;
  }

  try {
    const value = storage.getItem(STUDIO_THEME_STORAGE_KEY);
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

export function persistStoredThemePreference(
  storage: ThemeStorage | null | undefined,
  theme: Theme,
): void {
  if (!storage) {
    return;
  }

  try {
    storage.setItem(STUDIO_THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore browser storage failures and keep the in-memory preference active.
  }
}

export function applyThemePreferencePersistence(input: {
  storage: ThemeStorage | null | undefined;
  theme: Theme;
  hasMounted: boolean;
}): boolean {
  if (!input.hasMounted) {
    return true;
  }

  persistStoredThemePreference(input.storage, input.theme);
  return true;
}

export function resolveThemePreference(input: {
  storedTheme: Theme | null;
  defaultTheme: Theme | undefined;
  enableSystem: boolean | undefined;
  systemPrefersDark: boolean;
}): Theme {
  if (input.storedTheme) {
    return input.storedTheme;
  }

  if (input.defaultTheme === "light" || input.defaultTheme === "dark") {
    return input.defaultTheme;
  }

  if (input.defaultTheme === "system" && input.enableSystem) {
    return "system";
  }

  if (input.enableSystem) {
    return "system";
  }

  return "light";
}

export function resolveAppliedTheme(
  theme: Theme,
  systemPrefersDark: boolean,
): AppliedTheme {
  if (theme === "system") {
    return systemPrefersDark ? "dark" : "light";
  }

  return theme === "dark" ? "dark" : "light";
}
