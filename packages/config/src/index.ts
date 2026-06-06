export interface AgentConfig {
  readonly host: string;
  readonly port: number;
}

export const defaultAgentConfig: AgentConfig = {
  host: "127.0.0.1",
  port: 7391,
};
