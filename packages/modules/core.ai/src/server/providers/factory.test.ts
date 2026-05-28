import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import { RuntimeError } from "@mdcms/shared";

import { ECHO_PROVIDER_ID } from "./echo.js";
import {
  AI_MODEL_ENV_KEY,
  AI_PROVIDER_ENV_KEY,
  ANTHROPIC_API_KEY_ENV_KEY,
  GROQ_API_KEY_ENV_KEY,
  resolveAiProvider,
} from "./factory.js";
import { GROQ_PROVIDER_DEFAULT_MODEL, GROQ_PROVIDER_ID } from "./groq.js";
import { NULL_PROVIDER_ID } from "./null.js";

describe("resolveAiProvider", () => {
  test("returns null provider when env var is missing", () => {
    const provider = resolveAiProvider({ env: {} });
    assert.equal(provider.id, NULL_PROVIDER_ID);
  });

  test("returns null provider when env var is 'disabled'", () => {
    const provider = resolveAiProvider({
      env: { [AI_PROVIDER_ENV_KEY]: "disabled" },
    });
    assert.equal(provider.id, NULL_PROVIDER_ID);
  });

  test("returns echo provider when env var is 'echo'", () => {
    const provider = resolveAiProvider({
      env: { [AI_PROVIDER_ENV_KEY]: "echo" },
    });
    assert.equal(provider.id, ECHO_PROVIDER_ID);
  });

  test("normalizes case and whitespace", () => {
    const provider = resolveAiProvider({
      env: { [AI_PROVIDER_ENV_KEY]: "  ECHO  " },
    });
    assert.equal(provider.id, ECHO_PROVIDER_ID);
  });

  test("throws AI_PROVIDER_UNAVAILABLE for unknown ids", () => {
    assert.throws(
      () =>
        resolveAiProvider({
          env: { [AI_PROVIDER_ENV_KEY]: "openai" },
        }),
      (error) =>
        error instanceof RuntimeError &&
        error.code === "AI_PROVIDER_UNAVAILABLE",
    );
  });

  test("returns anthropic provider with default model when API key is set", () => {
    const provider = resolveAiProvider({
      env: {
        [AI_PROVIDER_ENV_KEY]: "anthropic",
        [ANTHROPIC_API_KEY_ENV_KEY]: "sk-ant-test-key",
      },
    });
    assert.equal(provider.id, "anthropic");
    assert.equal(provider.languageModel?.modelId, "claude-sonnet-4-6");
  });

  test("respects AI_MODEL override for anthropic", () => {
    const provider = resolveAiProvider({
      env: {
        [AI_PROVIDER_ENV_KEY]: "anthropic",
        [ANTHROPIC_API_KEY_ENV_KEY]: "sk-ant-test-key",
        [AI_MODEL_ENV_KEY]: "claude-opus-4-6",
      },
    });
    assert.equal(provider.languageModel?.modelId, "claude-opus-4-6");
  });

  test("anthropic without ANTHROPIC_API_KEY raises AI_PROVIDER_UNAVAILABLE", () => {
    assert.throws(
      () =>
        resolveAiProvider({
          env: { [AI_PROVIDER_ENV_KEY]: "anthropic" },
        }),
      (error) =>
        error instanceof RuntimeError &&
        error.code === "AI_PROVIDER_UNAVAILABLE",
    );
  });

  test("anthropic with whitespace-only ANTHROPIC_API_KEY raises AI_PROVIDER_UNAVAILABLE", () => {
    assert.throws(
      () =>
        resolveAiProvider({
          env: {
            [AI_PROVIDER_ENV_KEY]: "anthropic",
            [ANTHROPIC_API_KEY_ENV_KEY]: "   ",
          },
        }),
      (error) =>
        error instanceof RuntimeError &&
        error.code === "AI_PROVIDER_UNAVAILABLE",
    );
  });

  test("returns groq provider with default model when API key is set", () => {
    const provider = resolveAiProvider({
      env: {
        [AI_PROVIDER_ENV_KEY]: "groq",
        [GROQ_API_KEY_ENV_KEY]: "gsk_test_key",
      },
    });
    assert.equal(provider.id, GROQ_PROVIDER_ID);
    assert.equal(provider.languageModel?.modelId, GROQ_PROVIDER_DEFAULT_MODEL);
  });

  test("respects AI_MODEL override for groq", () => {
    const provider = resolveAiProvider({
      env: {
        [AI_PROVIDER_ENV_KEY]: "groq",
        [GROQ_API_KEY_ENV_KEY]: "gsk_test_key",
        [AI_MODEL_ENV_KEY]: "llama-3.1-8b-instant",
      },
    });
    assert.equal(provider.languageModel?.modelId, "llama-3.1-8b-instant");
  });

  test("groq without GROQ_API_KEY raises AI_PROVIDER_UNAVAILABLE", () => {
    assert.throws(
      () =>
        resolveAiProvider({
          env: { [AI_PROVIDER_ENV_KEY]: "groq" },
        }),
      (error) =>
        error instanceof RuntimeError &&
        error.code === "AI_PROVIDER_UNAVAILABLE",
    );
  });

  test("groq with whitespace-only GROQ_API_KEY raises AI_PROVIDER_UNAVAILABLE", () => {
    assert.throws(
      () =>
        resolveAiProvider({
          env: {
            [AI_PROVIDER_ENV_KEY]: "groq",
            [GROQ_API_KEY_ENV_KEY]: "   ",
          },
        }),
      (error) =>
        error instanceof RuntimeError &&
        error.code === "AI_PROVIDER_UNAVAILABLE",
    );
  });

  test("null provider exposes a null language model", () => {
    const provider = resolveAiProvider({ env: {} });
    assert.equal(provider.languageModel, null);
  });

  test("echo provider exposes a non-null language model", () => {
    const provider = resolveAiProvider({
      env: { [AI_PROVIDER_ENV_KEY]: "echo" },
    });
    assert.notEqual(provider.languageModel, null);
    assert.equal(provider.languageModel?.modelId, "echo-1");
  });
});
