// Only `bun run db:auth-schema` reads this: the CLI runs under Node, which cannot import bun:sqlite.
import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { apiKeyPlugin } from "../src/server/auth-plugins";

export const auth = betterAuth({
  database: drizzleAdapter(
    drizzle(async () => ({ rows: [] })),
    {
      provider: "sqlite",
    },
  ),
  emailAndPassword: { enabled: true },
  plugins: [apiKeyPlugin()],
});
