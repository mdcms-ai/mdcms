import assert from "node:assert/strict";

import { test } from "bun:test";

import {
  applyThemePreferencePersistence,
  STUDIO_THEME_STORAGE_KEY,
  persistStoredThemePreference,
  readStoredThemePreference,
  resolveAppliedTheme,
  resolveThemePreference,
} from "./next-themes-state.js";

function createStorage() {
  const values = new Map<string, string>();

  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

test("readStoredThemePreference prefers the Studio localStorage key", () => {
  const storage = createStorage();
  storage.setItem(STUDIO_THEME_STORAGE_KEY, "dark");

  assert.equal(readStoredThemePreference(storage), "dark");
});

test("persistStoredThemePreference writes to the Studio localStorage key", () => {
  const storage = createStorage();

  persistStoredThemePreference(storage, "dark");

  assert.equal(storage.getItem(STUDIO_THEME_STORAGE_KEY), "dark");
});

test("applyThemePreferencePersistence skips the initial mount and persists subsequent theme changes", () => {
  const storage = createStorage();

  const hasMounted = applyThemePreferencePersistence({
    storage,
    theme: "dark",
    hasMounted: false,
  });

  assert.equal(storage.getItem(STUDIO_THEME_STORAGE_KEY), null);
  assert.equal(hasMounted, true);

  applyThemePreferencePersistence({
    storage,
    theme: "dark",
    hasMounted,
  });

  assert.equal(storage.getItem(STUDIO_THEME_STORAGE_KEY), "dark");
});

test("resolveThemePreference prefers stored theme over runtime defaults", () => {
  assert.equal(
    resolveThemePreference({
      storedTheme: "dark",
      defaultTheme: "light",
      enableSystem: true,
      systemPrefersDark: false,
    }),
    "dark",
  );
});

test("resolveThemePreference falls back to system when enabled", () => {
  assert.equal(
    resolveThemePreference({
      storedTheme: null,
      defaultTheme: "system",
      enableSystem: true,
      systemPrefersDark: true,
    }),
    "system",
  );
  assert.equal(resolveAppliedTheme("system", true), "dark");
});

test("resolveThemePreference honours a 'system' default even without enableSystem", () => {
  assert.equal(
    resolveThemePreference({
      storedTheme: null,
      defaultTheme: "system",
      enableSystem: false,
      systemPrefersDark: false,
    }),
    "light",
  );
});

test("readStoredThemePreference returns 'system' when persisted", () => {
  const storage = createStorage();
  storage.setItem(STUDIO_THEME_STORAGE_KEY, "system");

  assert.equal(readStoredThemePreference(storage), "system");
});

test("resolveAppliedTheme picks light when 'system' and OS prefers light", () => {
  assert.equal(resolveAppliedTheme("system", false), "light");
});
