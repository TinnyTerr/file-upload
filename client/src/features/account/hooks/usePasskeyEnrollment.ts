import { startRegistration } from "@simplewebauthn/browser";
import { useState } from "react";
import { errorMessage } from "@/config/api";
import { mfaService } from "../services/mfaService";

export function usePasskeyEnrollment(onEnrolled: () => void) {
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const register = async (currentPassword: string, label?: string) => {
		setSubmitting(true);
		setError(null);
		try {
			const { options } =
				await mfaService.webauthnRegisterStart(currentPassword);
			const response = await startRegistration({ optionsJSON: options });
			await mfaService.webauthnRegisterFinish(response, label);
			onEnrolled();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setSubmitting(false);
		}
	};

	return { register, submitting, error };
}
