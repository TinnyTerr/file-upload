import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { errorMessage } from "@/config/api";
import { accountService } from "@/features/account/services/accountService";
import { useAuth } from "./auth";

const MIN_PASSWORD = 12;

export function useChangeCredentials() {
	const { refresh } = useAuth();
	const navigate = useNavigate();
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit(input: {
		current_password: string;
		new_username: string;
		new_password: string;
		confirm_password: string;
	}) {
		setError(null);
		if (input.new_password.length < MIN_PASSWORD) {
			setError(`New password must be at least ${MIN_PASSWORD} characters.`);
			return false;
		}
		if (input.new_password !== input.confirm_password) {
			setError("Passwords do not match.");
			return false;
		}
		setSubmitting(true);
		try {
			await accountService.changeCredentials({
				current_password: input.current_password,
				new_username: input.new_username,
				new_password: input.new_password,
			});
			await refresh();
			toast.success("Credentials updated", {
				description: "Other sessions were signed out.",
			});
			navigate("/files", { replace: true });
			return true;
		} catch (err) {
			setError(errorMessage(err));
			return false;
		} finally {
			setSubmitting(false);
		}
	}

	return { submit, submitting, error, minPassword: MIN_PASSWORD };
}
