import {
	MutationCache,
	QueryCache,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { ApiError } from "@/config/api";
import { ME_QUERY_KEY } from "@/features/auth/hooks/auth";

/** A 401 with this exact detail means the session itself is gone (expired,
 * revoked, signed out elsewhere) -- as opposed to, say, a wrong folder
 * password on a public page, which is also a 401 but must not bounce an
 * anonymous visitor to the login screen. */
function isSessionExpired(err: unknown): boolean {
	return (
		err instanceof ApiError &&
		err.status === 401 &&
		err.detail === "not authenticated"
	);
}

export function QueryProvider({ children }: { children: ReactNode }) {
	const [client] = useState(() => {
		const qc: QueryClient = new QueryClient({
			queryCache: new QueryCache({
				onError: (err) => {
					// Only while a user was actually loaded -- otherwise every public
					// page's queries would race the `me` fetch's own 401 on first load.
					if (isSessionExpired(err) && qc.getQueryData(ME_QUERY_KEY)) {
						qc.setQueryData(ME_QUERY_KEY, null);
					}
				},
			}),
			mutationCache: new MutationCache({
				onError: (err) => {
					if (isSessionExpired(err) && qc.getQueryData(ME_QUERY_KEY)) {
						qc.setQueryData(ME_QUERY_KEY, null);
					}
				},
			}),
			defaultOptions: {
				queries: {
					staleTime: 15_000,
					refetchOnWindowFocus: false,
					retry: (failureCount, error) => {
						// Don't retry auth/permission/not-found errors.
						if (
							error instanceof ApiError &&
							[401, 403, 404, 413].includes(error.status)
						) {
							return false;
						}
						return failureCount < 2;
					},
				},
			},
		});
		return qc;
	});

	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
