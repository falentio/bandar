import { RouteIcon } from "lucide-react";
import type { SessionControls } from "../use-session";
import { LoginForm } from "./login-form";

export function AuthPage({ auth }: { auth: SessionControls }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex items-center gap-2 self-center font-medium">
          <div className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <RouteIcon className="size-4" />
          </div>
          bandar
        </div>
        <LoginForm auth={auth} />
      </div>
    </div>
  );
}
