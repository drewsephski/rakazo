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

/** Newest readable credential per provider, used to hide models that sign-in cannot call. */
export async function modelCredentialAuthKindsForUser(
  prisma: PrismaClient,
  secretStore: Pick<EncryptedSecretStore, "load">,
  userId: string,
): Promise<Partial<Record<string, ModelCredentialAuthKind>>> {
  const rows = await prisma.userModelCredential.findMany({
    where: { userId },
    select: { provider: true, secretId: true },
    orderBy: newestModelCredentialOrder,
  });
  if (rows.length === 0) return {};
  const secrets = await prisma.secret.findMany({
    where: {
      id: { in: rows.map((row) => row.secretId) },
      userId,
      spaceId: null,
    },
    select: { id: true, ciphertext: true },
  });
  const ciphertextById = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
  const authByProvider: Partial<Record<string, ModelCredentialAuthKind>> = {};
  for (const row of rows) {
    if (authByProvider[row.provider]) continue;
    const ciphertext = ciphertextById.get(row.secretId);
    if (!ciphertext) continue;
    try {
      authByProvider[row.provider] = modelCredentialAuthKindFromPlaintext(
        secretStore.load(ciphertext, row.secretId),
      );
    } catch {
      // An unreadable newest credential must not hide an older readable one.
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
