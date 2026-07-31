import { startAuthentication } from "@simplewebauthn/browser";
import { useReducer } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { MFA_SETUP_PATH } from "@/components/layout/guards";
import { ApiError, errorMessage } from "@/config/api";
import {
	authService,
	isMfaRequired,
	type SessionResponse,
} from "../services/authService";
import { useAuth } from "./auth";

interface LocationState {
	from?: string;
}

type LoginState =
	| { step: "idle" }
	| { step: "password_submitting" }
	| { step: "mfa_required"; ticket: string; methods: ("totp" | "webauthn")[] }
	| { step: "mfa_submitting"; ticket: string; methods: ("totp" | "webauthn")[] }
	| { step: "passkey_submitting" };

type Action =
	| { type: "password_submitting" }
	| { type: "mfa_required"; ticket: string; methods: ("totp" | "webauthn")[] }
	| { type: "mfa_submitting" }
	| { type: "passkey_submitting" }
	| { type: "reset" };

function reducer(state: LoginState, action: Action): LoginState {
	switch (action.type) {
		case "password_submitting":
			return { step: "password_submitting" };
		case "mfa_required":
			return {
				step: "mfa_required",
				ticket: action.ticket,
				methods: action.methods,
			};
		case "mfa_submitting":
			return state.step === "mfa_required" || state.step === "mfa_submitting"
				? {
						step: "mfa_submitting",
						ticket: state.ticket,
						methods: state.methods,
					}
				: state;
		case "passkey_submitting":
			return { step: "passkey_submitting" };
		case "reset":
			return { step: "idle" };
		default:
			return state;
	}
}

export function useLogin(connId: string | null) {
	const { refresh } = useAuth();
	const navigate = useNavigate();
	const location = useLocation();
	const [state, dispatch] = useReducer(reducer, { step: "idle" });
	const [error, setErrorRaw] = useReducer(
		(_: string | null, v: string | null) => v,
		null,
	);

	function setError(msg: string | null) {
		setErrorRaw(msg);
	}

	async function land(res: SessionResponse) {
		await refresh();
		const dest = res.must_change_credentials
			? "/account/change"
			: res.force_mfa_enrollment
				? MFA_SETUP_PATH
				: ((location.state as LocationState)?.from ?? "/files");
		toast.success("Welcome back");
		navigate(dest, { replace: true });
	}

	async function login(username: string, password: string) {
		dispatch({ type: "password_submitting" });
		setError(null);
		try {
			const res = await authService.login(
				username,
				password,
				connId ?? undefined,
			);
			if (isMfaRequired(res)) {
				dispatch({
					type: "mfa_required",
					ticket: res.mfa_ticket,
					methods: res.methods,
				});
				return;
			}
			await land(res);
		} catch (err) {
			let msg = errorMessage(err);
			if (err instanceof ApiError) {
				if (err.status === 401) msg = "Invalid username or password.";
				else if (err.status === 429)
					msg = "Too many attempts — try again later.";
			}
			setError(msg);
			dispatch({ type: "reset" });
		}
	}

	async function verifyOtp(code: string) {
		if (state.step !== "mfa_required" && state.step !== "mfa_submitting")
			return;
		const ticket = state.ticket;
		dispatch({ type: "mfa_submitting" });
		setError(null);
		try {
			const res = await authService.verifyTotp(
				ticket,
				code,
				connId ?? undefined,
			);
			await land(res);
		} catch (err) {
			setError(
				err instanceof ApiError && err.status === 401
					? "Invalid code."
					: errorMessage(err),
			);
			dispatch({ type: "mfa_required", ticket, methods: state.methods });
		}
	}

	async function loginWithPasskey() {
		dispatch({ type: "passkey_submitting" });
		setError(null);
		try {
			const { options, conn_id: startedConnId } =
				await authService.webauthnLoginStart(connId ?? undefined);
			const response = await startAuthentication({ optionsJSON: options });
			const res = await authService.webauthnLoginFinish(
				startedConnId,
				response,
			);
			await land(res);
		} catch (err) {
			setError(errorMessage(err));
			dispatch({ type: "reset" });
		}
	}

	return {
		state,
		error,
		login,
		verifyOtp,
		loginWithPasskey,
		submitting: state.step === "password_submitting",
	};
}
