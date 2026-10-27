import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { SessionControls } from "../use-session";

type Mode = "sign-in" | "sign-up";

export function AuthPanel({ auth }: { readonly auth: SessionControls }) {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (auth.pending) return;

    if (mode === "sign-up") await auth.signUp({ name, email, password });
    else await auth.signIn({ email, password });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notes, per account</CardTitle>
        <CardDescription>Sign in or create an account to keep your own notes.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Button
            type="button"
            variant={mode === "sign-in" ? "default" : "outline"}
            size="sm"
            disabled={auth.pending}
            onClick={() => setMode("sign-in")}
          >
            Sign in
          </Button>
          <Button
            type="button"
            variant={mode === "sign-up" ? "default" : "outline"}
            size="sm"
            disabled={auth.pending}
            onClick={() => setMode("sign-up")}
          >
            Create account
          </Button>
        </div>

        <form onSubmit={submit} className="space-y-3">
          {mode === "sign-up" ? (
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Name"
              aria-label="Name"
              autoComplete="name"
              disabled={auth.pending}
            />
          ) : null}
          <Input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Email"
            aria-label="Email"
            autoComplete="email"
            disabled={auth.pending}
          />
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Password"
            aria-label="Password"
            autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
            disabled={auth.pending}
          />

          {auth.error === null ? null : (
            <p className="text-sm text-destructive" role="alert">
              {auth.error}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={auth.pending}>
            {mode === "sign-up" ? "Create account" : "Sign in"}
          </Button>
        </form>

        <p className="text-xs text-muted-foreground">
          Your session lives in an http-only cookie; each account sees only its own notes.
        </p>
      </CardContent>
    </Card>
  );
}
