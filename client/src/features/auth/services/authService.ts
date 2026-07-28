import type {
	AuthenticationResponseJSON,
	PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { api, setCsrfToken } from "@/config/api";

export interface SessionResponse {
	csrf_token: string;
	must_change_credentials: boolean;
	force_mfa_enrollment: boolean;
}

export interface MfaRequiredResponse {
	status: "mfa_required";
	mfa_ticket: string;
	methods: ("totp" | "webauthn")[];
}

export type LoginResponse = SessionResponse | MfaRequiredResponse;

export function isMfaRequired(res: LoginResponse): res is MfaRequiredResponse {
	return (res as MfaRequiredResponse).status === "mfa_required";
}

function landSession(res: SessionResponse): SessionResponse {
	setCsrfToken(res.csrf_token);
	return res;
}

export const authService = {
	login: async (username: string, password: string, connId?: string) => {
		const res = await api.post<LoginResponse>("/auth/login", {
			json: { username, password, conn_id: connId },
		});
		if (isMfaRequired(res)) return res;
		return landSession(res);
	},

	logout: async () => {
		try {
			await api.post("/auth/logout");
		} finally {
			setCsrfToken(null);
		}
	},

	wsToken: () =>
		api.get<{ conn_id: string; expires_in: number }>("/auth/ws-token"),

	verifyTotp: async (mfaTicket: string, code: string, connId?: string) => {
		const res = await api.post<SessionResponse>("/auth/totp/verify-login", {
			json: { mfa_ticket: mfaTicket, code, conn_id: connId },
		});
		return landSession(res);
	},

	webauthnLoginStart: (connId?: string) =>
		api.post<{
			options: PublicKeyCredentialRequestOptionsJSON;
			conn_id: string;
		}>("/auth/webauthn/login/start", {
			json: { conn_id: connId },
		}),

	webauthnLoginFinish: async (
		connId: string,
		response: AuthenticationResponseJSON,
	) => {
		const res = await api.post<SessionResponse>("/auth/webauthn/login/finish", {
			json: { conn_id: connId, response },
		});
		return landSession(res);
	},
};
