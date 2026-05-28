import {
  createContext,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";

import {
  applyThemePreferencePersistence,
  readStoredThemePreference,
  resolveAppliedTheme,
  resolveThemePreference,
  type Theme,
} from "./next-themes-state.js";

export type ThemeProviderProps = PropsWithChildren<{
  attribute?: string;
  defaultTheme?: Theme;
  enableSystem?: boolean;
  disableTransitionOnChange?: boolean;
}>;

type ThemeContextValue = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function readSystemPrefersDark(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return false;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolveInitialTheme(input: {
  defaultTheme: Theme | undefined;
  enableSystem: boolean | undefined;
}): Theme {
  const systemPrefersDark = readSystemPrefersDark();
  const storage =
    typeof window === "undefined" ? null : (window.localStorage ?? null);

  return resolveThemePreference({
    storedTheme: readStoredThemePreference(storage),
    defaultTheme: input.defaultTheme,
    enableSystem: input.enableSystem,
    systemPrefersDark,
  });
}

function applyDocumentTheme(
  attribute: string,
  theme: Theme,
  systemPrefersDark: boolean,
): void {
  if (typeof document === "undefined") {
    return;
  }

  const nextTheme = resolveAppliedTheme(theme, systemPrefersDark);

  if (attribute === "class") {
    document.documentElement.classList.toggle("dark", nextTheme === "dark");
    return;
  }

  document.documentElement.setAttribute(attribute, nextTheme);
}

export function ThemeProvider({
  children,
  attribute = "class",
  defaultTheme = "light",
  enableSystem = false,
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<Theme>(() =>
    resolveInitialTheme({
      defaultTheme,
      enableSystem,
    }),
  );
  const systemPrefersDarkRef = useRef(readSystemPrefersDark());
  const themeRef = useRef(theme);
  const hasMountedThemePersistence = useRef(false);

  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);

  useEffect(() => {
    if (
      !enableSystem ||
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event: MediaQueryListEvent) => {
      systemPrefersDarkRef.current = event.matches;
      applyDocumentTheme(attribute, themeRef.current, event.matches);
    };

    systemPrefersDarkRef.current = mediaQuery.matches;
    applyDocumentTheme(attribute, themeRef.current, mediaQuery.matches);

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);

      return () => {
        mediaQuery.removeEventListener("change", handleChange);
      };
    }

    mediaQuery.addListener(handleChange);

    return () => {
      mediaQuery.removeListener(handleChange);
    };
  }, [attribute, enableSystem]);

  useEffect(() => {
    applyDocumentTheme(attribute, theme, systemPrefersDarkRef.current);
  }, [attribute, theme]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    hasMountedThemePersistence.current = applyThemePreferencePersistence({
      storage: window.localStorage ?? null,
      theme,
      hasMounted: hasMountedThemePersistence.current,
    });
  }, [theme]);

  const value = useMemo(
    () => ({
      theme,
      setTheme,
    }),
    [theme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const value = use(ThemeContext);

  if (!value) {
    throw new Error("useTheme must be used within ThemeProvider.");
  }

  return value;
}
