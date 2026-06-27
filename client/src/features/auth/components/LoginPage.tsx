import { AuthShell, InlineAlert } from "../../../components/layout/AuthShell";
import { Button } from "../../../components/ui/Button";
import { Field, Input } from "../../../components/ui/primitives";
import { useLogin } from "../hooks/useLogin";

export function LoginPage() {
  const { username, setUsername, password, setPassword, error, busy, submit } = useLogin();

  return (
    <AuthShell
      title="Sign in"
      subtitle="Encrypted, expiring file dispatch"
      foot={
        <>
          Sessions are short-lived. Links can expire,
          <br />
          cap their downloads, and self-destruct.
        </>
      }
    >
      {error && <InlineAlert kind="error">{error}</InlineAlert>}
      <form onSubmit={submit} className="space-y-4">
        <Field label="Username">
          <Input
            type="text"
            autoComplete="username"
            autoCapitalize="off"
            spellCheck={false}
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Button type="submit" full disabled={busy} className="mt-2">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </AuthShell>
  );
}
