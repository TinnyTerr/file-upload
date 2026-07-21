import { useState } from "react";
import { LogIn, AlertCircle, Fingerprint } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLogin } from "../hooks/useLogin";
import { useLoginConnection } from "../hooks/useLoginConnection";
import { SecondFactorStep } from "./SecondFactorStep";

export function LoginPage() {
  const { connId } = useLoginConnection();
  const { state, error, login, verifyOtp, loginWithPasskey, submitting } = useLogin(connId);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const showSecondFactor = state.step === "mfa_required" || state.step === "mfa_submitting";

  return (
    <div className="flex flex-1 items-center justify-center py-10">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-xl bg-brand-gradient shadow-lg shadow-primary/30">
            <LogIn className="size-6 text-white" />
          </div>
          <CardTitle className="text-xl">Welcome back</CardTitle>
          <CardDescription>
            {showSecondFactor ? "Confirm it's you to finish signing in" : "Sign in to upload and manage your files"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {showSecondFactor ? (
            <SecondFactorStep
              methods={state.methods}
              submitting={state.step === "mfa_submitting"}
              error={error}
              onVerifyOtp={verifyOtp}
              onUsePasskey={loginWithPasskey}
            />
          ) : (
            <div className="space-y-4">
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  login(username, password);
                }}
              >
                <div className="space-y-1.5">
                  <Label htmlFor="username">Username</Label>
                  <Input
                    id="username"
                    autoFocus
                    autoComplete="username webauthn"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    aria-invalid={!!error}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    aria-invalid={!!error}
                    required
                  />
                </div>

                {error && (
                  <p className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    <AlertCircle className="size-4 shrink-0" />
                    {error}
                  </p>
                )}

                <Button type="submit" className="w-full" loading={submitting}>
                  Sign in
                </Button>
              </form>

              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">or</span>
                </div>
              </div>

              <Button
                type="button"
                variant="outline"
                className="w-full"
                loading={state.step === "passkey_submitting"}
                onClick={loginWithPasskey}
              >
                <Fingerprint className="size-4" /> Sign in with a passkey
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
