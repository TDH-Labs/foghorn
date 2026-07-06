// Connector contract (drydock src/connectors pattern): validate credentials
// against the live provider with ZERO writes, report per-check results, store
// nothing — creds stay in .env.local. Fetch-injected for offline unit tests.

export interface ConnectCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ConnectResult {
  connector: string;
  ok: boolean;
  checks: ConnectCheck[];
}

export interface Connector {
  name: string;
  validate(fetchImpl?: typeof fetch): Promise<ConnectResult>;
}

export function summarize(connector: string, checks: ConnectCheck[]): ConnectResult {
  return { connector, ok: checks.every((c) => c.ok), checks };
}

export function envPresent(name: string): ConnectCheck {
  const v = process.env[name];
  // presence check prints only boolean/length — never the value
  return {
    name: `env:${name}`,
    ok: !!v && v.length > 0,
    detail: v ? `set (len=${v.length})` : "missing",
  };
}
