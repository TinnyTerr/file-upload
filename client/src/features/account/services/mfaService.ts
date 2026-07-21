import { api } from "@/config/api";
import type { RegistrationResponseJSON, PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";

export interface MfaCredential {
  id: number;
  kind: "totp" | "webauthn";
  label: string | null;
  created_at: string;
  updated_at: string | null;
}

export const mfaService = {
  list: () => api.get<{ credentials: MfaCredential[] }>("/account/mfa").then((r) => r.credentials),

  totpSetup: () => api.post<{ secret: string; otpauth_url: string }>("/account/mfa/totp/setup"),

  totpConfirm: (body: { secret: string; code: string; label?: string }) =>
    api.post<{ status: string; id: number }>("/account/mfa/totp/confirm", { json: body }),

  remove: (id: number, current_password: string) =>
    api.delete<{ status: string }>(`/account/mfa/${id}`, { json: { current_password } }),

  webauthnRegisterStart: () =>
    api.post<{ options: PublicKeyCredentialCreationOptionsJSON }>("/account/mfa/webauthn/register/start"),

  webauthnRegisterFinish: (response: RegistrationResponseJSON, label?: string) =>
    api.post<{ status: string; id: number }>("/account/mfa/webauthn/register/finish", { json: { response, label } }),
};
