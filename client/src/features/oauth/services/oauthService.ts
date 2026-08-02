import { api } from "@/config/api";
import type {
	ConsentRequest,
	NewOauthApp,
	NewOauthAppInput,
	OauthApp,
	OauthAuthorization,
} from "../types";

/** The consent request's raw query string is passed through untouched: the
 * backend re-validates every parameter (client_id, redirect_uri, scope, PKCE),
 * so the page never has to interpret them itself. */
export type AuthorizeParams = Record<string, string>;

export const oauthService = {
	listApps: () =>
		api.get<{ clients: OauthApp[] }>("/oauth/clients").then((r) => r.clients),

	createApp: (input: NewOauthAppInput) =>
		api.post<NewOauthApp>("/oauth/clients", { json: input }),

	deleteApp: (clientId: string) => api.delete(`/oauth/clients/${clientId}`),

	consentInfo: (params: AuthorizeParams) =>
		api.get<ConsentRequest>("/oauth/authorize/info", { query: params }),

	decide: (params: AuthorizeParams, approve: boolean) =>
		api.post<{ redirect_to: string }>("/oauth/authorize", {
			json: { ...params, approve },
		}),

	listAuthorizations: () =>
		api
			.get<{ authorizations: OauthAuthorization[] }>("/oauth/authorizations")
			.then((r) => r.authorizations),

	revokeAuthorization: (clientId: string) =>
		api.delete(`/oauth/authorizations/${clientId}`),
};
