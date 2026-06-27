import { AuthShell, InlineAlert } from "../../../components/layout/AuthShell";
import { Button } from "../../../components/ui/Button";
import { Field, Input } from "../../../components/ui/primitives";
import { useChangeCredentials } from "../hooks/useChangeCredentials";

export function ChangePage() {
  const {
    current, setCurrent,
    newUsername, setNewUsername,
    newPassword, setNewPassword,
    confirm, setConfirm,
    alert, busy, submit,
  } = useChangeCredentials();

  return (
    <AuthShell title="Update credentials" subtitle="Set a new username and password to continue">
      {alert && <InlineAlert kind={alert.kind}>{alert.msg}</InlineAlert>}
      <form onSubmit={submit} className="space-y-4">
        <Field label="Current password">
          <Input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <div className="h-px bg-[var(--color-line)]" />
        <Field label="New username">
          <Input
            type="text"
            autoCapitalize="off"
            spellCheck={false}
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
          />
        </Field>
        <Field label="New password (min 12 chars)">
          <Input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </Field>
        <Field label="Confirm password">
          <Input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        <Button type="submit" full disabled={busy} className="mt-2">
          {busy ? "Updating…" : "Update credentials"}
        </Button>
      </form>
    </AuthShell>
  );
}
