import { useState } from "react";
import { errorMessage } from "@/config/api";
import { mfaService } from "../services/mfaService";

type EnrollState =
	| { step: "idle" }
	| { step: "secret-issued"; secret: string; otpauthUrl: string }
	| { step: "confirming"; secret: string; otpauthUrl: string }
	| { step: "done" };

export function useTotpEnrollment(onEnrolled: () => void) {
	const [state, setState] = useState<EnrollState>({ step: "idle" });
	const [error, setError] = useState<string | null>(null);

	const start = async () => {
		setError(null);
		try {
			const { secret, otpauth_url } = await mfaService.totpSetup();
			setState({ step: "secret-issued", secret, otpauthUrl: otpauth_url });
		} catch (err) {
			setError(errorMessage(err));
		}
	};

	const confirm = async (code: string, label: string) => {
		if (state.step !== "secret-issued" && state.step !== "confirming") return;
		setState({
			step: "confirming",
			secret: state.secret,
			otpauthUrl: state.otpauthUrl,
		});
		setError(null);
		try {
			await mfaService.totpConfirm({
				secret: state.secret,
				code,
				label: label || undefined,
			});
			setState({ step: "done" });
			onEnrolled();
		} catch (err) {
			setState({
				step: "secret-issued",
				secret: state.secret,
				otpauthUrl: state.otpauthUrl,
			});
			setError(errorMessage(err));
		}
	};

	const reset = () => {
		setState({ step: "idle" });
		setError(null);
	};

	return { state, error, start, confirm, reset };
}
