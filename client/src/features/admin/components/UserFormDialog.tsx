import type * as React from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordStrengthMeter } from "@/components/ui/password-strength-meter";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAdminUsers } from "../hooks/useAdminUsers";
import type { AdminUser } from "../types";

interface Props {
	open: boolean;
	onClose: () => void;
	/** Provide to edit; omit to create. */
	editing?: AdminUser | null;
}

export function UserFormDialog({ open, onClose, editing }: Props) {
	return (
		<Dialog open={open} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="max-w-md">
				{/* Keyed on the user being edited, so the fields always start from
				    that user's current values instead of the previous target's. */}
				{open && (
					<UserForm
						key={editing?.id ?? "new"}
						onClose={onClose}
						editing={editing}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

function UserForm({ onClose, editing }: Omit<Props, "open">) {
	const { create, update } = useAdminUsers();
	const isEdit = !!editing;
	const [username, setUsername] = useState(editing?.username ?? "");
	const [password, setPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [role, setRole] = useState<string>(editing?.role ?? "user");
	const [canUpload, setCanUpload] = useState(
		editing?.permissions?.can_upload ?? true,
	);
	const [mfaRequired, setMfaRequired] = useState(
		editing?.mfa_required ?? false,
	);

	const onSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (isEdit && editing) {
			await update.mutateAsync({
				id: editing.id,
				username: username || undefined,
				password: password || undefined,
				role,
				mfa_required: mfaRequired,
			});
		} else {
			await create.mutateAsync({
				username,
				password,
				role,
				can_upload: canUpload,
			});
		}
		onClose();
	};

	const pending = create.isPending || update.isPending;
	const mismatch = password.length > 0 && password !== confirmPassword;

	return (
		<>
			<DialogHeader>
				<DialogTitle>
					{isEdit ? `Edit ${editing?.username}` : "New user"}
				</DialogTitle>
				<DialogDescription>
					{isEdit
						? "Leave password blank to keep it unchanged."
						: "Password must be at least 12 characters."}
				</DialogDescription>
			</DialogHeader>

			<form id="user-form" onSubmit={onSubmit} className="space-y-3">
				<div className="space-y-1.5">
					<Label htmlFor="u-name">Username</Label>
					<Input
						id="u-name"
						value={username}
						onChange={(e) => setUsername(e.target.value)}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="u-pass">Password</Label>
					<Input
						id="u-pass"
						type="password"
						autoComplete="new-password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
					/>
					<PasswordStrengthMeter password={password} />
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="u-pass-confirm">Confirm password</Label>
					<Input
						id="u-pass-confirm"
						type="password"
						autoComplete="new-password"
						value={confirmPassword}
						onChange={(e) => setConfirmPassword(e.target.value)}
						aria-invalid={mismatch}
					/>
					{mismatch && (
						<p className="text-xs text-destructive">Passwords don't match.</p>
					)}
				</div>
				<div className="space-y-1.5">
					<Label>Role</Label>
					<Select value={role} onValueChange={setRole}>
						<SelectTrigger>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="user">User</SelectItem>
							<SelectItem value="master">Master</SelectItem>
						</SelectContent>
					</Select>
				</div>
				{!isEdit && (
					<div className="flex items-center justify-between">
						<Label>Can upload</Label>
						<Switch checked={canUpload} onCheckedChange={setCanUpload} />
					</div>
				)}
				{isEdit && role !== "master" && (
					<div className="flex items-center justify-between">
						<div>
							<Label>Require multi-factor authentication</Label>
							<p className="text-xs text-muted-foreground">
								{editing?.mfa_enrolled
									? "Blocks password-only login once enabled."
									: "Password-only login stays allowed until they enroll a passkey or authenticator."}
							</p>
						</div>
						<Switch checked={mfaRequired} onCheckedChange={setMfaRequired} />
					</div>
				)}
				{isEdit && role === "master" && (
					<p className="text-xs text-muted-foreground">
						Master accounts always require MFA once enrolled.
					</p>
				)}
			</form>

			<DialogFooter>
				<Button type="button" variant="ghost" onClick={onClose}>
					Cancel
				</Button>
				<Button
					type="submit"
					form="user-form"
					loading={pending}
					disabled={!username || mismatch || (!isEdit && password.length < 12)}
				>
					{isEdit ? "Save" : "Create user"}
				</Button>
			</DialogFooter>
		</>
	);
}
