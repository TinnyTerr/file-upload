export interface ApiKey {
	id: number;
	user_key_number: number;
	bound_ip: string | null;
	active: boolean;
	created_at: string;
	last_used_at: string | null;
}

export interface NewApiKey {
	id: number;
	user_key_number: number;
	key: string;
}

/** Admin view augments keys with owner info. */
export interface AdminApiKey extends ApiKey {
	owner_id: number;
	owner_username: string;
}
