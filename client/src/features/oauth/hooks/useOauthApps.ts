import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/config/api";
import { oauthService } from "../services/oauthService";
import type { NewOauthAppInput } from "../types";

const APPS_QUERY = ["oauth", "apps"] as const;
const AUTHZ_QUERY = ["oauth", "authorizations"] as const;

/** Apps this user has registered (the developer side). */
export function useOauthApps() {
	const qc = useQueryClient();
	const invalidate = () => qc.invalidateQueries({ queryKey: APPS_QUERY });

	const list = useQuery({
		queryKey: APPS_QUERY,
		queryFn: oauthService.listApps,
	});

	const create = useMutation({
		mutationFn: (input: NewOauthAppInput) => oauthService.createApp(input),
		onSuccess: () => invalidate(),
		onError: (err) =>
			toast.error("Couldn't register app", { description: errorMessage(err) }),
	});

	const deleteApp = useMutation({
		mutationFn: (clientId: string) => oauthService.deleteApp(clientId),
		onSuccess: () => {
			toast.success("App deleted");
			invalidate();
			// Deleting the app revokes its tokens server-side, so the user's list of
			// authorized apps can be stale too.
			qc.invalidateQueries({ queryKey: AUTHZ_QUERY });
		},
		onError: (err) =>
			toast.error("Couldn't delete app", { description: errorMessage(err) }),
	});

	return { list, create, deleteApp };
}

/** Apps this user has granted access to (the consenting side). */
export function useOauthAuthorizations() {
	const qc = useQueryClient();

	const list = useQuery({
		queryKey: AUTHZ_QUERY,
		queryFn: oauthService.listAuthorizations,
	});

	const revoke = useMutation({
		mutationFn: (clientId: string) =>
			oauthService.revokeAuthorization(clientId),
		onSuccess: () => {
			toast.success("Access revoked");
			qc.invalidateQueries({ queryKey: AUTHZ_QUERY });
		},
		onError: (err) =>
			toast.error("Couldn't revoke access", { description: errorMessage(err) }),
	});

	return { list, revoke };
}
