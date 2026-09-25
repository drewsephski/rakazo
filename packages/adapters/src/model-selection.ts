import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { usableModelId } from "@rakazo/contracts";
import {
  type findDefaultModelCredential,
  findModelCredential,
  newestModelCredentialOrder,
  type PrismaClient,
} from "@rakazo/db";
import type { ModelCredentialAuthKind } from "./pi-catalog-availability.js";
import {
  catalogModelAvailableForAuth,
  listAvailablePiCatalog,
  modelCredentialAuthKindFromPlaintext,
  UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE,
} from "./pi-catalog-availability.js";
import { listPiCatalog, scriptedCatalogEntry } from "./pi-models.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./pi-openai-compatible-provider.js";
import type { EncryptedSecretStore } from "./secrets.js";

type ModelCredential = Awaited<ReturnType<typeof findDefaultModelCredential>>;

export function isCatalogModelChoice(provider: string, modelId: string) {
  return [...listPiCatalog(), scriptedCatalogEntry].some(
    (item) => item.provider === provider && item.id === modelId,
  );
}

export function defaultCatalogModelId(
  provider: string,
  credentialPlaintext?: string,
): string | null {
  const authKind = credentialPlaintext
    ? modelCredentialAuthKindFromPlaintext(credentialPlaintext)
    : "disconnected";
  const authByProvider: Partial<Record<string, ModelCredentialAuthKind>> =
    authKind === "disconnected" ? {} : { [provider]: authKind };
  const entry = listAvailablePiCatalog(authByProvider).find((item) => item.provider === provider);
  return usableModelId(entry?.id);
}

export class UnavailableModelForAuthError extends Error {
  constructor(message = UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE) {
    super(message);
    this.name = "UnavailableModelForAuthError";
  }
}

/**
 * Auth kind of the credential each provider would use in this space.
 * A space preference wins over a newer credential stored on the account.
 * With no preference, the newest readable credential is the fallback.
 */
export async function modelCredentialAuthKindsForSpace(
  prisma: PrismaClient,
  secretStore: Pick<EncryptedSecretStore, "load">,
  scope: Pick<Actor, "userId" | "spaceId">,
): Promise<Partial<Record<string, ModelCredentialAuthKind>>> {
  const [credentials, preferences] = await Promise.all([
    prisma.userModelCredential.findMany({
      where: { userId: scope.userId },
      select: { provider: true, secretId: true },
      orderBy: newestModelCredentialOrder,
    }),
    prisma.spaceModelPreference.findMany({
      where: { userId: scope.userId, spaceId: scope.spaceId },
      select: { credential: { select: { provider: true, secretId: true } } },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    }),
  ]);

  const selectedSecretId = new Map<string, string>();
  for (const preference of preferences) {
    const { provider, secretId } = preference.credential;
    if (!selectedSecretId.has(provider)) selectedSecretId.set(provider, secretId);
  }
  const fallbackSecretIds = new Map<string, string[]>();
  for (const credential of credentials) {
    const secretIds = fallbackSecretIds.get(credential.provider) ?? [];
    secretIds.push(credential.secretId);
    fallbackSecretIds.set(credential.provider, secretIds);
  }
  const providers = new Set([...selectedSecretId.keys(), ...fallbackSecretIds.keys()]);
  if (providers.size === 0) return {};

  const secretIds = [
    ...new Set([...selectedSecretId.values(), ...[...fallbackSecretIds.values()].flat()]),
  ];
  const secrets = await prisma.secret.findMany({
    where: { id: { in: secretIds }, userId: scope.userId, spaceId: null },
    select: { id: true, ciphertext: true },
  });
  const ciphertextById = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
  const readKind = (secretId: string): ModelCredentialAuthKind | undefined => {
    const ciphertext = ciphertextById.get(secretId);
    if (!ciphertext) return undefined;
    try {
      return modelCredentialAuthKindFromPlaintext(secretStore.load(ciphertext, secretId));
    } catch {
      return undefined;
    }
  };

  const authByProvider: Partial<Record<string, ModelCredentialAuthKind>> = {};
  for (const provider of providers) {
    const selected = selectedSecretId.get(provider);
    if (selected) {
      const kind = readKind(selected);
      // The space already chose this credential. An unreadable secret stays
      // disconnected instead of advertising a newer key the space is not using.
      if (kind) authByProvider[provider] = kind;
      continue;
    }
    for (const secretId of fallbackSecretIds.get(provider) ?? []) {
      const kind = readKind(secretId);
      if (!kind) continue;
      authByProvider[provider] = kind;
      break;
    }
  }
  return authByProvider;
}

export function validateModelAuthAvailability(
  provider: string,
  modelId: string,
  credentialPlaintext?: string,
): string | undefined {
  if (!credentialPlaintext) return undefined;
  const authKind = modelCredentialAuthKindFromPlaintext(credentialPlaintext);
  const catalogEntry = listPiCatalog().find(
    (item) => item.provider === provider && item.id === modelId,
  );
  if (!catalogModelAvailableForAuth(provider, modelId, authKind, catalogEntry?.auth)) {
    return UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE;
  }
  return undefined;
}

/** Readable rejection when a stored credential cannot call this catalog model. */
export async function validateStoredModelAuth(
  prisma: Pick<PrismaClient, "secret">,
  secretStore: Pick<EncryptedSecretStore, "load">,
  userId: string,
  secretId: string,
  provider: string,
  modelId: string,
): Promise<string | undefined> {
  const secret = await prisma.secret.findFirst({
    where: { id: secretId, userId, spaceId: null },
    select: { id: true, ciphertext: true },
  });
  if (!secret) return undefined;
  try {
    return validateModelAuthAvailability(
      provider,
      modelId,
      secretStore.load(secret.ciphertext, secret.id),
    );
  } catch {
    // Unreadable credentials fail when the run loads them, not as an auth mismatch.
    return undefined;
  }
}

export async function validateConnectedModelChoice(
  prisma: PrismaClient,
  actor: Pick<Actor, "userId" | "spaceId">,
  provider: string,
  modelId: string,
) {
  const credential = await findModelCredential(prisma, actor, provider);
  if (!credential) return "Connect that model provider first";
  if (!usableModelId(modelId)) return "Unknown model for that provider";
  if (isCatalogModelChoice(provider, modelId)) return undefined;
  // Free-form saved IDs only resolve at runtime for openai-compatible connections.
  if (provider !== OPENAI_COMPATIBLE_PROVIDER_ID) {
    return "Unknown model for that provider";
  }
  const savedChoice = await prisma.spaceModelPreference.findFirst({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      modelId,
      credential: { userId: actor.userId, provider },
    },
    select: { id: true },
  });
  return savedChoice ? undefined : "Unknown model for that provider";
}

/** Select configuration without loading secrets or applying a runtime-specific fallback. */
export function selectConfiguredModel(input: {
  bot: {
    modelProvider: string | null;
    modelId: string | null;
    thinkingLevel: string | null;
  } | null;
  overrideCredential: ModelCredential;
  defaultCredential: ModelCredential;
  settings: { defaultModelProvider: string | null; defaultModelId: string | null } | null;
  deployment: { provider: string; model: string } | null;
}) {
  const { bot, overrideCredential, defaultCredential, settings, deployment } = input;
  const hasOverride = Boolean(bot?.modelProvider && usableModelId(bot.modelId));
  // The override provider, model and credential must win together.
  const useOverride = Boolean(hasOverride && overrideCredential);
  const credential = useOverride ? overrideCredential : defaultCredential;
  return {
    provider:
      (useOverride ? bot!.modelProvider : null) ??
      credential?.provider ??
      settings?.defaultModelProvider ??
      deployment?.provider,
    id:
      usableModelId(useOverride ? bot!.modelId : null) ??
      usableModelId(credential?.defaultModel) ??
      (credential ? defaultCatalogModelId(credential.provider) : null) ??
      usableModelId(settings?.defaultModelId) ??
      usableModelId(deployment?.model),
    credential,
    // Preserve bot thinking for the Space default; drop it for an unavailable override.
    thinkingLevel:
      hasOverride && !useOverride
        ? null
        : ((bot?.thinkingLevel as AgentRunRequest["model"]["thinkingLevel"]) ?? null),
  };
}
