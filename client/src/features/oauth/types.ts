export interface OauthApp {
	id: number;
	client_id: string;
	name: string;
	redirect_uris: string[];
	scopes: string[];
	/** Confidential clients hold a secret; public ones are PKCE-only. */
	confidential: boolean;
	active: boolean;
	created_at: string;
}

/** Registration response — `client_secret` is present exactly once, and only
 * for confidential clients. */
export interface NewOauthApp extends OauthApp {
	client_secret: string | null;
}

export interface NewOauthAppInput {
	name: string;
	redirect_uris: string[];
	scopes: string[];
	confidential: boolean;
}

/** One scope of a pending consent request, with whether this user can actually
 * delegate it (they cannot grant a permission they don't hold). */
export interface ConsentScope {
	scope: string;
	requires: string | null;
	granted: boolean;
}

export interface ConsentRequest {
	client: {
		client_id: string;
		name: string;
		owner_username: string | null;
	};
	redirect_uri: string;
	state: string | null;
	scopes: ConsentScope[];
}

/** An app the current user has authorized, collapsed to one row per app. */
export interface OauthAuthorization {
	client_id: string;
	name: string | null;
	scopes: string[];
	authorized_at: string;
	last_used_at: string | null;
}
