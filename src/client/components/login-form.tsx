import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { SessionControls } from "../use-session";

export function LoginForm({ auth }: { auth: SessionControls }) {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitAttempted, setSubmitAttempted] = useState(false);

  const unconfirmed = confirm !== password;

  const confirmError =
    mode === "sign-up" && (confirm === "" ? submitAttempted : unconfirmed)
      ? "Passwords do not match."
      : null;

  const switchMode = () => {
    setMode(mode === "sign-in" ? "sign-up" : "sign-in");
    setPassword("");
    setConfirm("");
    setSubmitAttempted(false);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (auth.pending) return;

    if (mode === "sign-in") {
      await auth.signIn({ email, password });

      return;
    }

    if (unconfirmed || confirm === "") {
      setSubmitAttempted(true);

      return;
    }

    await auth.signUp({ name, email, password });
  };

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-xl">
          {mode === "sign-in" ? "Welcome back" : "Create your account"}
        </CardTitle>
        <CardDescription>
          {mode === "sign-in" ? "Sign in to your gateway." : "One account, every model."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit}>
          <FieldGroup>
            {mode === "sign-up" ? (
              <Field>
                <FieldLabel htmlFor="name">Name</FieldLabel>
                <Input
                  id="name"
                  autoComplete="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={auth.pending}
                  required
                />
              </Field>
            ) : null}

            <Field>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input
                id="email"
                type="email"
                placeholder="m@example.com"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={auth.pending}
                required
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="password">Password</FieldLabel>
              <Input
                id="password"
                type="password"
                autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={auth.pending}
                required
              />
            </Field>

            {mode === "sign-up" ? (
              <Field data-invalid={confirmError !== null}>
                <FieldLabel htmlFor="confirm-password">Confirm password</FieldLabel>
                <Input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  aria-invalid={confirmError !== null}
                  disabled={auth.pending}
                />
                <FieldError>{confirmError}</FieldError>
              </Field>
            ) : null}

            <Field>
              <FieldError>{auth.error}</FieldError>
              <Button type="submit" disabled={auth.pending || confirmError !== null}>
                {mode === "sign-in" ? "Sign in" : "Create account"}
              </Button>
              <FieldDescription className="text-center">
                {mode === "sign-in" ? "Don't have an account? " : "Already have an account? "}
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-sm"
                  onClick={switchMode}
                  disabled={auth.pending}
                >
                  {mode === "sign-in" ? "Create one" : "Sign in"}
                </Button>
              </FieldDescription>
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
