import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import type { Config } from "./config";
import * as authSchema from "./db/auth-schema";
import type { Db } from "./db/client";

export type SessionUser = { readonly id: string };

export type Auth = {
  readonly handler: (request: Request) => Promise<Response>;
  readonly getSession: (headers: Headers) => Promise<SessionUser | null>;
};

export function createAuth(db: Db, config: Config): Auth {
  const auth = betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite", schema: authSchema }),
    emailAndPassword: { enabled: true },
    baseURL: config.authUrl,
    secret: config.authSecret,
    trustedOrigins: [...config.trustedOrigins],
  });

  return {
    handler: (request) => auth.handler(request),
    getSession: async (headers) => (await auth.api.getSession({ headers }))?.user ?? null,
  };
}
