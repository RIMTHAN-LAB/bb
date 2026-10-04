import { z } from "zod";

const canonicalAbsolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      /^\/(?:[^/\u0000]+\/)*[^/\u0000]+$/.test(value) &&
      !value.split("/").some((part) => part === "." || part === ".."),
    "homePath must be a canonical absolute directory path",
  );
export const nativeContextSchema = z
  .object({
    homePath: canonicalAbsolutePathSchema,
    instructionsConfig: z
      .object({
        path: canonicalAbsolutePathSchema,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    mcpConfig: z
      .object({
        path: canonicalAbsolutePathSchema,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      [value.mcpConfig, value.instructionsConfig].every(
        (reference) =>
          reference === undefined ||
          reference.path.startsWith(value.homePath + "/"),
      ),
    "Protected configuration must be inside the exact native home",
  );
export type NativeContext = z.infer<typeof nativeContextSchema>;

export const threadConfigurationReleaseSchema = z
  .object({
    generation: z.number().int().nonnegative(),
    releasedProviderSessionId: z.string().min(1),
    releasedAt: z.number().int().nonnegative(),
  })
  .strict();
export type ThreadConfigurationRelease = z.infer<
  typeof threadConfigurationReleaseSchema
>;

export const threadProviderConfigurationSchema = z
  .object({
    release: threadConfigurationReleaseSchema.optional(),
    nativeContext: nativeContextSchema.optional(),
    generation: z.number().int().nonnegative(),
  })
  .strict();
export type ThreadProviderConfiguration = z.infer<
  typeof threadProviderConfigurationSchema
>;

const unavailableEvidenceSchema = z
  .object({ status: z.literal("unavailable"), reason: z.string().min(1) })
  .strict();
export const providerConfigurationReadbackSchema = z
  .object({
    tools: z.union([
      unavailableEvidenceSchema,
      z
        .object({
          status: z.literal("observed"),
          protocol: z.literal("mcp"),
          toolNames: z.array(z.string().min(1)).max(1024),
          initializedAt: z.number().int().nonnegative(),
          listedAt: z.number().int().nonnegative(),
        })
        .strict(),
    ]),
    skills: z.union([
      unavailableEvidenceSchema,
      z
        .object({
          status: z.literal("observed"),
          protocol: z.literal("hermes-acp"),
          skills: z
            .array(
              z
                .object({
                  name: z.string().min(1),
                  origin: z.enum(["project", "user", "plugin"]),
                  filePath: z.string().min(1),
                  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
                  skillFileDigest: z.string().regex(/^[a-f0-9]{64}$/),
                })
                .strict(),
            )
            .max(1024),
        })
        .strict(),
    ]),
    instructions: z.union([
      unavailableEvidenceSchema,
      z
        .object({
          status: z.literal("observed"),
          protocol: z.literal("hermes-acp"),
          instructionsDigest: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ]),
    nativeInstructions: z.union([
      unavailableEvidenceSchema,
      z
        .object({
          status: z.literal("observed"),
          protocol: z.literal("hermes-acp"),
          nativeInstructionsDigest: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ]),
    nativeMcp: z.union([
      unavailableEvidenceSchema,
      z
        .object({
          status: z.literal("observed"),
          protocol: z.literal("hermes-acp"),
          servers: z
            .array(
              z
                .object({
                  name: z.string().min(1),
                  transport: z.enum(["stdio", "http", "sse"]),
                  status: z.enum([
                    "connected",
                    "disabled",
                    "connecting",
                    "failed",
                    "lazy",
                    "configured",
                  ]),
                  toolNames: z.array(z.string().min(1)).max(1024),
                  schemaDigest: z
                    .string()
                    .regex(/^[a-f0-9]{64}$/)
                    .optional(),
                })
                .strict(),
            )
            .max(32),
        })
        .strict(),
    ]),
    nativeConversation: z
      .union([
        unavailableEvidenceSchema,
        z
          .object({
            status: z.literal("observed"),
            protocol: z.literal("hermes-acp"),
            messageCount: z.number().int().nonnegative().max(10000),
            historyDigest: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      ])
      .optional(),
    nativeToolNames: z.array(z.string().min(1)).max(2048).optional(),
  })
  .strict();
export type ProviderConfigurationReadback = z.infer<
  typeof providerConfigurationReadbackSchema
>;

export const UNAVAILABLE_PROVIDER_CONFIGURATION_READBACK: ProviderConfigurationReadback =
  {
    tools: {
      status: "unavailable",
      reason: "provider_tool_discovery_not_observed",
    },
    skills: {
      status: "unavailable",
      reason: "provider_skill_readback_unavailable",
    },
    instructions: {
      status: "unavailable",
      reason: "provider_instruction_readback_unavailable",
    },
    nativeInstructions: {
      status: "unavailable",
      reason: "provider_native_instruction_readback_unavailable",
    },
    nativeMcp: {
      status: "unavailable",
      reason: "provider_native_mcp_readback_unavailable",
    },
  };

export const threadConfigurationDeliverySchema = z
  .object({
    status: z.literal("delivered"),
    threadId: z.string().min(1),
    providerId: z.string().min(1),
    providerSessionId: z.string().min(1),
    providerInstanceId: z.string().min(1).optional(),
    generation: z.number().int().nonnegative(),
    catalogHash: z.string().regex(/^[a-f0-9]{64}$/),
    sourceTreeHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(1024),
    toolNames: z.array(z.string().min(1)).max(1024),
    instructionsDigest: z.string().regex(/^[a-f0-9]{64}$/),
    deliveredAt: z.number().int().nonnegative(),
    nativeContext: nativeContextSchema.optional(),
    providerReadback: providerConfigurationReadbackSchema,
  })
  .strict();
export type ThreadConfigurationDelivery = z.infer<
  typeof threadConfigurationDeliverySchema
>;
