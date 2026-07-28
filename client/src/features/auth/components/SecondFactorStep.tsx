import { AlertCircle, Fingerprint, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SecondFactorStep({
	methods,
	submitting,
	error,
	onVerifyOtp,
	onUsePasskey,
}: {
	methods: ("totp" | "webauthn")[];
	submitting: boolean;
	error: string | null;
	onVerifyOtp: (code: string) => void;
	onUsePasskey: () => void;
}) {
	const [code, setCode] = useState("");

	return (
		<div className="space-y-4">
			<div className="flex flex-col items-center gap-2 text-center">
				<div className="flex size-10 items-center justify-center rounded-full bg-primary/10">
					<ShieldCheck className="size-5 text-primary" />
				</div>
				<p className="text-sm font-medium text-foreground">
					Enter your verification code
				</p>
				<p className="text-xs text-muted-foreground">
					Open your authenticator app and enter the 6-digit code.
				</p>
			</div>

			{methods.includes("totp") && (
				<form
					className="space-y-3"
					onSubmit={(e) => {
						e.preventDefault();
						onVerifyOtp(code);
					}}
				>
					<div className="space-y-1.5">
						<Label htmlFor="otp">Verification code</Label>
						<Input
							id="otp"
							autoFocus
							inputMode="numeric"
							autoComplete="one-time-code"
							value={code}
							onChange={(e) => {
								const next = e.target.value.replace(/\D/g, "").slice(0, 6);
								setCode(next);
								if (next.length === 6) onVerifyOtp(next);
							}}
							placeholder="123456"
							aria-invalid={!!error}
							required
						/>
					</div>
					<Button
						type="submit"
						className="w-full"
						loading={submitting}
						disabled={code.length !== 6}
					>
						Verify
					</Button>
				</form>
			)}

			{methods.includes("webauthn") && (
				<Button
					type="button"
					variant="outline"
					className="w-full"
					onClick={onUsePasskey}
					disabled={submitting}
				>
					<Fingerprint className="size-4" /> Use a passkey instead
				</Button>
			)}

			{error && (
				<p className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
					<AlertCircle className="size-4 shrink-0" />
					{error}
				</p>
			)}
		</div>
	);
}
