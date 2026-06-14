import { AppError, Result, err, ok } from "@droid-webscr/shared";
import { z } from "zod";

export interface AgentConfig {
  readonly authToken?: string | undefined;
  readonly bindHost: string;
  readonly clipboard: {
    readonly enabled: boolean;
  };
  readonly port: number;
}

export const defaultAgentConfig: AgentConfig = {
  authToken: undefined,
  bindHost: "127.0.0.1",
  clipboard: { enabled: false },
  port: 7391,
};

export type ConfigErrorCode = "CONFIG_INVALID" | "CONFIG_UNSAFE_BIND";

export class ConfigError extends AppError<ConfigErrorCode> {}

const schema = z
  .object({
    authToken: z.string().min(1).optional(),
    bindHost: z.string().default("127.0.0.1"),
    clipboard: z
      .object({
        enabled: z.boolean().default(false),
      })
      .default({ enabled: false }),
    port: z.number().int().min(0).max(65_535).default(7391),
  })
  .strict();

export function validateAgentConfig(input: unknown): Result<AgentConfig, ConfigError> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return err(new ConfigError("CONFIG_INVALID", parsed.error.message));
  }

  if (!isLocalBind(parsed.data.bindHost) && !parsed.data.authToken) {
    return err(
      new ConfigError("CONFIG_UNSAFE_BIND", "Non-local bind addresses require authToken."),
    );
  }

  return ok(parsed.data);
}

export function isLocalBind(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
