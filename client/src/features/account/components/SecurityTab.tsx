import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Fingerprint,
	KeyRound,
	ShieldCheck,
	Smartphone,
	Trash2,
} from "lucide-react";
import * as React from "react";
import { useState } from "react";
import { toast } from "sonner";
import {
	ErrorMsg,
	PasswordInput,
	SubModal,
} from "@/components/layout/SettingsModal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { QRCode } from "@/components/ui/qr-code";
import { errorMessage } from "@/config/api";
import { usePasskeyEnrollment } from "../hooks/usePasskeyEnrollment";
import { useTotpEnrollment } from "../hooks/useTotpEnrollment";
import { type MfaCredential, mfaService } from "../services/mfaService";

const MFA_KEY = ["account", "mfa"];

function TotpSetupModal({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
}) {
	const qc = useQueryClient();
	const { state, error, start, confirm, reset } = useTotpEnrollment(() => {
		qc.invalidateQueries({ queryKey: MFA_KEY });
		toast.success("Authenticator app added");
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: deliberately keyed on `open` alone -- this runs the open/close transition. start()/reset() are re-created every render and start() advances state.step, so adding them loops.
	React.useEffect(() => {
		if (open && state.step === "idle") void start();
		if (!open) reset();
	}, [open]);

	React.useEffect(() => {
		if (state.step === "done") onOpenChange(false);
	}, [state.step, onOpenChange]);

	return (
		<SubModal
			open={open}
			onOpenChange={onOpenChange}
			title="Set up authenticator app"
		>
			{(state.step === "secret-issued" || state.step === "confirming") && (
				// Mounted only while open, so the code/label fields start blank every time.
				<TotpSetupForm
					otpauthUrl={state.otpauthUrl}
					secret={state.secret}
					confirming={state.step === "confirming"}
					error={error}
					onConfirm={confirm}
					onOpenChange={onOpenChange}
				/>
			)}
			{state.step === "idle" && error && <ErrorMsg message={error} />}
		</SubModal>
	);
}

function TotpSetupForm({
	otpauthUrl,
	secret,
	confirming,
	error,
	onConfirm,
	onOpenChange,
}: {
	otpauthUrl: string;
	secret: string;
	confirming: boolean;
	error: string | null;
	onConfirm: (code: string, label: string) => void;
	onOpenChange: (v: boolean) => void;
}) {
	const [code, setCode] = useState("");
	const [label, setLabel] = useState("");

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		void onConfirm(code, label);
	};

	return (
		<form onSubmit={handleSubmit} className="space-y-4">
			<p className="text-sm text-muted-foreground">
				Scan this QR code with your authenticator app, then enter the 6-digit
				code it shows.
			</p>
			<div className="flex justify-center">
				<QRCode value={otpauthUrl} size={180} />
			</div>
			<p className="break-all rounded-md bg-secondary/40 px-3 py-2 text-center font-mono text-xs text-muted-foreground">
				{secret}
			</p>
			<div className="space-y-1.5">
				<Label>Label (optional)</Label>
				<Input
					value={label}
					onChange={(e) => setLabel(e.target.value)}
					placeholder="Phone"
				/>
			</div>
			<div className="space-y-1.5">
				<Label>6-digit code</Label>
				<Input
					value={code}
					onChange={(e) =>
						setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
					}
					inputMode="numeric"
					autoComplete="one-time-code"
					placeholder="123456"
					required
				/>
			</div>
			{error && <ErrorMsg message={error} />}
			<div className="flex justify-end gap-2">
				<Button
					type="button"
					variant="ghost"
					onClick={() => onOpenChange(false)}
				>
					Cancel
				</Button>
				<Button type="submit" loading={confirming} disabled={code.length !== 6}>
					Confirm
				</Button>
			</div>
		</form>
	);
}

function PasskeyAddModal({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
}) {
	const qc = useQueryClient();
	const { register, submitting, error } = usePasskeyEnrollment(() => {
		qc.invalidateQueries({ queryKey: MFA_KEY });
		toast.success("Passkey added");
		onOpenChange(false);
	});

	return (
		<SubModal open={open} onOpenChange={onOpenChange} title="Add a passkey">
			{/* Mounted only while open, so the label field starts blank every time. */}
			<PasskeyAddForm
				submitting={submitting}
				error={error}
				onRegister={register}
				onOpenChange={onOpenChange}
			/>
		</SubModal>
	);
}

function PasskeyAddForm({
	submitting,
	error,
	onRegister,
	onOpenChange,
}: {
	submitting: boolean;
	error: string | null;
	onRegister: (label?: string) => void;
	onOpenChange: (v: boolean) => void;
}) {
	const [label, setLabel] = useState("");

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		void onRegister(label || undefined);
	};

	return (
		<form onSubmit={handleSubmit} className="space-y-4">
			<p className="text-sm text-muted-foreground">
				Your browser will prompt you to use a fingerprint, face scan, security
				key, or device PIN.
			</p>
			<div className="space-y-1.5">
				<Label>Label (optional)</Label>
				<Input
					value={label}
					onChange={(e) => setLabel(e.target.value)}
					placeholder="Laptop"
				/>
			</div>
			{error && <ErrorMsg message={error} />}
			<div className="flex justify-end gap-2">
				<Button
					type="button"
					variant="ghost"
					onClick={() => onOpenChange(false)}
				>
					Cancel
				</Button>
				<Button type="submit" loading={submitting}>
					Continue
				</Button>
			</div>
		</form>
	);
}

function RemoveCredentialModal({
	credential,
	onOpenChange,
}: {
	credential: MfaCredential | null;
	onOpenChange: (v: boolean) => void;
}) {
	const qc = useQueryClient();
	const [pw, setPw] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	const close = () => {
		onOpenChange(false);
		setPw("");
		setError(null);
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!credential) return;
		setSubmitting(true);
		setError(null);
		try {
			await mfaService.remove(credential.id, pw);
			toast.success("Removed");
			qc.invalidateQueries({ queryKey: MFA_KEY });
			close();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<SubModal
			open={!!credential}
			onOpenChange={(o) => !o && close()}
			title="Remove credential"
		>
			<form onSubmit={handleSubmit} className="space-y-4">
				<p className="text-sm text-muted-foreground">
					Enter your password to remove this credential.
				</p>
				<div className="space-y-1.5">
					<Label>Current password</Label>
					<PasswordInput
						value={pw}
						onChange={(e) => setPw(e.target.value)}
						autoComplete="current-password"
						required
					/>
				</div>
				{error && <ErrorMsg message={error} />}
				<div className="flex justify-end gap-2">
					<Button type="button" variant="ghost" onClick={close}>
						Cancel
					</Button>
					<Button
						type="submit"
						loading={submitting}
						className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
					>
						Remove
					</Button>
				</div>
			</form>
		</SubModal>
	);
}

export function SecurityTab() {
	const { data: credentials, isLoading } = useQuery({
		queryKey: MFA_KEY,
		queryFn: mfaService.list,
	});
	const [setupOpen, setSetupOpen] = useState(false);
	const [passkeyOpen, setPasskeyOpen] = useState(false);
	const [removeTarget, setRemoveTarget] = useState<MfaCredential | null>(null);

	const totp = credentials?.filter((c) => c.kind === "totp") ?? [];
	const passkeys = credentials?.filter((c) => c.kind === "webauthn") ?? [];

	return (
		<div className="space-y-4">
			<div>
				<div className="mb-1 flex items-center gap-2">
					<ShieldCheck className="size-4 text-primary" />
					<h2 className="text-sm font-semibold text-foreground">
						Two-factor authentication
					</h2>
				</div>
				<p className="text-xs text-muted-foreground">
					Add an authenticator app or passkey to secure your login.
				</p>
			</div>

			<div className="space-y-2">
				<div className="flex items-center justify-between gap-3">
					<p className="text-sm font-medium text-foreground">
						Authenticator app
					</p>
					<Button
						variant="outline"
						size="sm"
						onClick={() => setSetupOpen(true)}
					>
						<Smartphone className="size-3.5" /> Add
					</Button>
				</div>

				{isLoading ? (
					<div className="h-12 w-full animate-pulse rounded-lg bg-secondary/40" />
				) : totp.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No authenticator app enrolled.
					</p>
				) : (
					<div className="space-y-2">
						{totp.map((c) => (
							<div
								key={c.id}
								className="flex items-center gap-3 rounded-lg border border-border bg-card/30 px-3 py-2.5"
							>
								<KeyRound className="size-4 shrink-0 text-muted-foreground" />
								<div className="min-w-0 flex-1">
									<p className="text-sm font-medium">
										{c.label || "Authenticator app"}
									</p>
									<p className="text-xs text-muted-foreground">
										Added {new Date(c.created_at).toLocaleDateString()}
									</p>
								</div>
								<Button
									variant="ghost"
									size="icon"
									className="shrink-0 text-destructive"
									onClick={() => setRemoveTarget(c)}
								>
									<Trash2 className="size-4" />
								</Button>
							</div>
						))}
					</div>
				)}
			</div>

			<div className="space-y-2">
				<div className="flex items-center justify-between gap-3">
					<p className="text-sm font-medium text-foreground">Passkeys</p>
					<Button
						variant="outline"
						size="sm"
						onClick={() => setPasskeyOpen(true)}
					>
						<Fingerprint className="size-3.5" /> Add
					</Button>
				</div>

				{isLoading ? (
					<div className="h-12 w-full animate-pulse rounded-lg bg-secondary/40" />
				) : passkeys.length === 0 ? (
					<p className="text-sm text-muted-foreground">No passkeys enrolled.</p>
				) : (
					<div className="space-y-2">
						{passkeys.map((c) => (
							<div
								key={c.id}
								className="flex items-center gap-3 rounded-lg border border-border bg-card/30 px-3 py-2.5"
							>
								<Fingerprint className="size-4 shrink-0 text-muted-foreground" />
								<div className="min-w-0 flex-1">
									<p className="text-sm font-medium">{c.label || "Passkey"}</p>
									<p className="text-xs text-muted-foreground">
										Added {new Date(c.created_at).toLocaleDateString()}
									</p>
								</div>
								<Button
									variant="ghost"
									size="icon"
									className="shrink-0 text-destructive"
									onClick={() => setRemoveTarget(c)}
								>
									<Trash2 className="size-4" />
								</Button>
							</div>
						))}
					</div>
				)}
			</div>

			<TotpSetupModal open={setupOpen} onOpenChange={setSetupOpen} />
			<PasskeyAddModal open={passkeyOpen} onOpenChange={setPasskeyOpen} />
			<RemoveCredentialModal
				credential={removeTarget}
				onOpenChange={(o) => !o && setRemoveTarget(null)}
			/>
		</div>
	);
}
