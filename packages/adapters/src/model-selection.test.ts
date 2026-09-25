import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  defaultCatalogModelId,
  modelCredentialAuthKindsForSpace,
  selectConfiguredModel,
  validateConnectedModelChoice,
  validateModelAuthAvailability,
} from "./model-selection.js";
import { listAvailablePiCatalog } from "./pi-catalog-availability.js";

type SelectionInput = Parameters<typeof selectConfiguredModel>[0];

function credential(provider: string, defaultModel: string | null) {
  return {
    id: `credential-${provider}`,
    userId: "user-1",
    provider,
    label: provider,
    secretId: `secret-${provider}`,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    isDefault: false,
    defaultModel,
  };
}

const spaceCredential = credential("space-provider", "space-model");
const overrideCredential = credential("bot-provider", "stored-model");
const bot = { modelProvider: "bot-provider", modelId: "bot-model", thinkingLevel: "high" };
const defaults: SelectionInput = {
  bot: null,
  overrideCredential: null,
  defaultCredential: spaceCredential,
  settings: { defaultModelProvider: "settings-provider", defaultModelId: "settings-model" },
  deployment: { provider: "deployment-provider", model: "deployment-model" },
};

describe("configured model selection", () => {
  it.each<{
    name: string;
    input: Partial<SelectionInput>;
    expected: ReturnType<typeof selectConfiguredModel>;
  }>([
    {
      name: "uses the bot's model with its own credential",
      input: { bot, overrideCredential },
      expected: {
        provider: "bot-provider",
        id: "bot-model",
        credential: overrideCredential,
        thinkingLevel: "high",
      },
    },
    {
      name: "drops override thinking when its provider has no credential",
      input: { bot },
      expected: {
        provider: "space-provider",
        id: "space-model",
        credential: spaceCredential,
        thinkingLevel: null,
      },
    },
    {
      name: "keeps bot thinking with the Space default",
      input: { bot: { modelProvider: null, modelId: null, thinkingLevel: "high" } },
      expected: {
        provider: "space-provider",
        id: "space-model",
        credential: spaceCredential,
        thinkingLevel: "high",
      },
    },
    {
      name: "does not select an incomplete bot override",
      input: { bot: { ...bot, modelId: null }, overrideCredential },
      expected: {
        provider: "space-provider",
        id: "space-model",
        credential: spaceCredential,
        thinkingLevel: "high",
      },
    },
    {
      name: "uses settings before deployment defaults without inventing a credential",
      input: { defaultCredential: null },
      expected: {
        provider: "settings-provider",
        id: "settings-model",
        credential: null,
        thinkingLevel: null,
      },
    },
    {
      name: "uses deployment defaults when no stored configuration exists",
      input: { defaultCredential: null, settings: null },
      expected: {
        provider: "deployment-provider",
        id: "deployment-model",
        credential: null,
        thinkingLevel: null,
      },
    },
    {
      name: "leaves missing configuration for the caller's runtime fallback or failure path",
      input: { defaultCredential: null, settings: null, deployment: null },
      expected: {
        provider: undefined,
        id: null,
        credential: null,
        thinkingLevel: null,
      },
    },
    {
      name: "skips a literal null model id and uses the provider catalog instead",
      input: {
        defaultCredential: credential("anthropic", "null"),
        settings: null,
        deployment: null,
      },
      expected: {
        provider: "anthropic",
        id: defaultCatalogModelId("anthropic"),
        credential: credential("anthropic", "null"),
        thinkingLevel: null,
      },
    },
    {
      name: "does not treat a sentinel bot override as a selected model",
      input: { bot: { ...bot, modelId: "null" }, overrideCredential },
      expected: {
        provider: "space-provider",
        id: "space-model",
        credential: spaceCredential,
        thinkingLevel: "high",
      },
    },
  ])("$name", ({ input, expected }) => {
    expect(selectConfiguredModel({ ...defaults, ...input })).toEqual(expected);
  });
});

describe("defaultCatalogModelId", () => {
  it("skips Codex Spark as the default for ChatGPT subscription credentials", () => {
    const oauth = JSON.stringify({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    });
    expect(defaultCatalogModelId("openai-codex", oauth)).not.toBe("gpt-5.3-codex-spark");
    expect(defaultCatalogModelId("openai-codex", oauth)).toBeTruthy();
  });
});

describe("space catalog auth", () => {
  const scope = { userId: "user-1", spaceId: "space-1" };
  const oauth = JSON.stringify({
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
  });
  const apiKey = "sk-test-api-key-12345678";
  const spark = "gpt-5.3-codex-spark";

  function authPrisma(options: {
    credentials: Array<{ provider: string; secretId: string }>;
    preferences: Array<{ provider: string; secretId: string }>;
    secrets: Array<{ id: string; ciphertext: string }>;
  }) {
    const credentialFindMany = vi.fn().mockResolvedValue(options.credentials);
    const preferenceFindMany = vi.fn().mockResolvedValue(
      options.preferences.map((preference) => ({
        credential: { provider: preference.provider, secretId: preference.secretId },
      })),
    );
    const secretFindMany = vi.fn().mockResolvedValue(options.secrets);
    const prisma = {
      userModelCredential: { findMany: credentialFindMany },
      spaceModelPreference: { findMany: preferenceFindMany },
      secret: { findMany: secretFindMany },
    } as unknown as PrismaClient;
    return { prisma, credentialFindMany, preferenceFindMany, secretFindMany };
  }

  it("uses the space's selected openai-codex credential instead of the newest one", async () => {
    const { prisma, preferenceFindMany } = authPrisma({
      credentials: [
        { provider: "openai-codex", secretId: "secret-api" },
        { provider: "openai-codex", secretId: "secret-oauth" },
      ],
      preferences: [{ provider: "openai-codex", secretId: "secret-oauth" }],
      secrets: [{ id: "secret-oauth", ciphertext: "cipher-oauth" }],
    });
    const load = vi.fn((ciphertext: string) => (ciphertext === "cipher-oauth" ? oauth : apiKey));

    const auth = await modelCredentialAuthKindsForSpace(prisma, { load }, scope);

    expect(auth).toEqual({ "openai-codex": "oauth" });
    expect(preferenceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: scope.userId, spaceId: scope.spaceId },
      }),
    );
    expect(
      listAvailablePiCatalog(auth).some(
        (entry) => entry.provider === "openai-codex" && entry.id === spark,
      ),
    ).toBe(false);
  });

  it("keeps Spark when the space preference is an API key and a newer credential is oauth", async () => {
    const { prisma } = authPrisma({
      credentials: [
        { provider: "openai-codex", secretId: "secret-oauth" },
        { provider: "openai-codex", secretId: "secret-api" },
      ],
      preferences: [{ provider: "openai-codex", secretId: "secret-api" }],
      secrets: [{ id: "secret-api", ciphertext: "cipher-api" }],
    });

    const auth = await modelCredentialAuthKindsForSpace(prisma, { load: () => apiKey }, scope);

    expect(auth).toEqual({ "openai-codex": "api_key" });
    expect(
      listAvailablePiCatalog(auth).some(
        (entry) => entry.provider === "openai-codex" && entry.id === spark,
      ),
    ).toBe(true);
  });

  it("falls back to the newest readable credential when the space has no preference", async () => {
    const { prisma } = authPrisma({
      credentials: [
        { provider: "openai-codex", secretId: "secret-broken" },
        { provider: "openai-codex", secretId: "secret-api" },
      ],
      preferences: [],
      secrets: [
        { id: "secret-broken", ciphertext: "cipher-broken" },
        { id: "secret-api", ciphertext: "cipher-api" },
      ],
    });
    const load = vi.fn((ciphertext: string) => {
      if (ciphertext === "cipher-broken") throw new Error("unreadable");
      return apiKey;
    });

    await expect(modelCredentialAuthKindsForSpace(prisma, { load }, scope)).resolves.toEqual({
      "openai-codex": "api_key",
    });
  });

  it("does not replace an unreadable space credential with a newer API key", async () => {
    const { prisma } = authPrisma({
      credentials: [{ provider: "openai-codex", secretId: "secret-api" }],
      preferences: [{ provider: "openai-codex", secretId: "secret-oauth" }],
      secrets: [
        { id: "secret-oauth", ciphertext: "cipher-oauth" },
        { id: "secret-api", ciphertext: "cipher-api" },
      ],
    });
    const load = vi.fn((ciphertext: string) => {
      if (ciphertext === "cipher-oauth") throw new Error("unreadable");
      return apiKey;
    });

    const auth = await modelCredentialAuthKindsForSpace(prisma, { load }, scope);

    expect(auth).toEqual({});
    expect(
      listAvailablePiCatalog(auth).some(
        (entry) => entry.provider === "openai-codex" && entry.id === spark,
      ),
    ).toBe(false);
  });
});

describe("model auth availability", () => {
  it("rejects Codex Spark for oauth credentials and keeps other catalog models", () => {
    const oauth = JSON.stringify({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    });
    expect(validateModelAuthAvailability("openai-codex", "gpt-5.3-codex-spark", oauth)).toMatch(
      /not available with your current sign-in/i,
    );
    expect(validateModelAuthAvailability("openai-codex", "gpt-6-luna", oauth)).toBeUndefined();
    expect(
      validateModelAuthAvailability("openai-codex", "gpt-5.3-codex-spark", "sk-test-api-key"),
    ).toBeUndefined();
  });
});

describe("connected model validation", () => {
  const actor: Pick<Actor, "userId" | "spaceId"> = {
    userId: "user-1",
    spaceId: "space-1",
  };

  it("accepts catalog and saved free-form models but rejects unavailable choices", async () => {
    const catalogPrisma = {
      spaceModelPreference: { findFirst: async () => null },
      userModelCredential: { findFirst: async () => credential("xai", null) },
    } as unknown as PrismaClient;
    await expect(
      validateConnectedModelChoice(catalogPrisma, actor, "xai", "grok-4.6"),
    ).resolves.toBeUndefined();
    await expect(
      validateConnectedModelChoice(catalogPrisma, actor, "xai", "not-a-model"),
    ).resolves.toBe("Unknown model for that provider");

    const preferenceFindFirst = vi.fn(
      async (args: {
        where: {
          spaceId?: string;
          userId?: string;
          modelId?: string;
          credential?: { provider?: string; userId?: string };
        };
      }) => {
        if (args.where.modelId) {
          if (
            args.where.spaceId === actor.spaceId &&
            args.where.userId === actor.userId &&
            args.where.modelId === "private-model" &&
            args.where.credential?.provider === "openai-compatible" &&
            args.where.credential?.userId === actor.userId
          ) {
            return { id: "saved-private-model" };
          }
          return null;
        }
        if (args.where.credential?.provider === "openai-compatible") {
          return {
            credential: credential("openai-compatible", "newest-model"),
            isDefault: true,
            modelId: "newest-model",
          };
        }
        return null;
      },
    );
    const customPrisma = {
      spaceModelPreference: { findFirst: preferenceFindFirst },
      userModelCredential: { findFirst: async () => null },
    } as unknown as PrismaClient;
    await expect(
      validateConnectedModelChoice(customPrisma, actor, "openai-compatible", "private-model"),
    ).resolves.toBeUndefined();
    expect(preferenceFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          spaceId: actor.spaceId,
          userId: actor.userId,
          modelId: "private-model",
          credential: { userId: actor.userId, provider: "openai-compatible" },
        }),
        select: { id: true },
      }),
    );
    await expect(
      validateConnectedModelChoice(customPrisma, actor, "openai-compatible", "missing-model"),
    ).resolves.toBe("Unknown model for that provider");

    const disconnectedPrisma = {
      spaceModelPreference: { findFirst: async () => null },
      userModelCredential: { findFirst: async () => null },
    } as unknown as PrismaClient;
    await expect(
      validateConnectedModelChoice(disconnectedPrisma, actor, "anthropic", "claude-opus-4-6"),
    ).resolves.toBe("Connect that model provider first");

    await expect(validateConnectedModelChoice(catalogPrisma, actor, "xai", "null")).resolves.toBe(
      "Unknown model for that provider",
    );
    await expect(
      validateConnectedModelChoice(catalogPrisma, actor, "xai", "undefined"),
    ).resolves.toBe("Unknown model for that provider");
  });
});
