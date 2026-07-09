import { afterEach, describe, expect, test } from "bun:test";
import { activeProvider, modelForStage } from "./models.ts";

const SAVED_ENV = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED_ENV)) delete process.env[k];
  Object.assign(process.env, SAVED_ENV);
  for (const k of ["FOGHORN_LLM_PROVIDER", "OPENROUTER_API_KEY", "FOGHORN_MODEL", "FOGHORN_MODEL_DRAFT"]) {
    delete process.env[k];
  }
});

describe("activeProvider", () => {
  test("defaults to anthropic with no env set", () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.FOGHORN_LLM_PROVIDER;
    expect(activeProvider()).toBe("anthropic");
  });

  test("auto-detects openrouter when its key is present", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    expect(activeProvider()).toBe("openrouter");
  });

  test("explicit FOGHORN_LLM_PROVIDER wins over auto-detect either direction", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    process.env.FOGHORN_LLM_PROVIDER = "anthropic";
    expect(activeProvider()).toBe("anthropic");
    delete process.env.OPENROUTER_API_KEY;
    process.env.FOGHORN_LLM_PROVIDER = "openrouter";
    expect(activeProvider()).toBe("openrouter");
  });
});

describe("modelForStage", () => {
  test("provider swap changes the tier default", () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.FOGHORN_LLM_PROVIDER;
    expect(modelForStage("draft")).toBe("claude-opus-4-8");
    expect(modelForStage("judge_voice")).toBe("claude-haiku-4-5");

    process.env.FOGHORN_LLM_PROVIDER = "openrouter";
    expect(modelForStage("draft")).toBe("deepseek/deepseek-chat");
    expect(modelForStage("judge_voice")).toBe("deepseek/deepseek-chat");
  });

  test("per-stage override wins over provider tier default", () => {
    process.env.FOGHORN_LLM_PROVIDER = "openrouter";
    process.env.FOGHORN_MODEL_DRAFT = "z-ai/glm-5.2";
    expect(modelForStage("draft")).toBe("z-ai/glm-5.2");
    expect(modelForStage("judge_voice")).toBe("deepseek/deepseek-chat"); // unaffected
  });

  test("global override wins over provider tier default but not per-stage", () => {
    process.env.FOGHORN_LLM_PROVIDER = "openrouter";
    process.env.FOGHORN_MODEL = "z-ai/glm-5.2";
    expect(modelForStage("judge_risk")).toBe("z-ai/glm-5.2");
    process.env.FOGHORN_MODEL_DRAFT = "deepseek/deepseek-v4-pro";
    expect(modelForStage("draft")).toBe("deepseek/deepseek-v4-pro");
    expect(modelForStage("judge_risk")).toBe("z-ai/glm-5.2");
  });
});
