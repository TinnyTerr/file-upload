import { useState } from "react";
import { ShieldAlert, AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useChangeCredentials } from "../hooks/useChangeCredentials";
import { useAuth } from "../hooks/auth";

export function ChangePage() {
  const { user, mustChangeCredentials } = useAuth();
  const { submit, submitting, error, minPassword } = useChangeCredentials();
  const [form, setForm] = useState({
    current_password: "",
    new_username: user?.username ?? "",
    new_password: "",
    confirm_password: "",
  });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const mustChange = mustChangeCredentials || user?.must_change_credentials;

  return (
    <div className="mx-auto max-w-lg">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="size-5 text-warning" />
            {mustChange ? "Secure your account" : "Change credentials"}
          </CardTitle>
          <CardDescription>
            {mustChange
              ? "This account uses temporary credentials. Set a new username and password to continue."
              : "Updating your password signs out all other sessions."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit(form);
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="current">Current password</Label>
              <Input
                id="current"
                type="password"
                autoComplete="current-password"
                value={form.current_password}
                onChange={set("current_password")}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="newuser">New username</Label>
              <Input
                id="newuser"
                autoComplete="username"
                value={form.new_username}
                onChange={set("new_username")}
                required
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="newpass">New password</Label>
                <Input
                  id="newpass"
                  type="password"
                  autoComplete="new-password"
                  value={form.new_password}
                  onChange={set("new_password")}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm">Confirm password</Label>
                <Input
                  id="confirm"
                  type="password"
                  autoComplete="new-password"
                  value={form.confirm_password}
                  onChange={set("confirm_password")}
                  required
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">Minimum {minPassword} characters.</p>

            {error && (
              <p className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <AlertCircle className="size-4 shrink-0" />
                {error}
              </p>
            )}

            <Button type="submit" className="w-full" loading={submitting}>
              Update credentials
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
