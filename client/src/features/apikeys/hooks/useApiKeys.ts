import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/config/api";
import { keysService } from "../services/keysService";

const KEYS_QUERY = ["apikeys", "list"] as const;

export function useApiKeys() {
	const qc = useQueryClient();
	const invalidate = () => qc.invalidateQueries({ queryKey: KEYS_QUERY });

	const list = useQuery({ queryKey: KEYS_QUERY, queryFn: keysService.list });

	const create = useMutation({
		mutationFn: () => keysService.create(),
		onSuccess: () => invalidate(),
		onError: (err) =>
			toast.error("Couldn't create key", { description: errorMessage(err) }),
	});

	const deleteKey = useMutation({
		mutationFn: (keyId: number) => keysService.delete(keyId),
		onSuccess: () => {
			toast.success("Key deleted");
			invalidate();
		},
		onError: (err) =>
			toast.error("Couldn't delete key", { description: errorMessage(err) }),
	});

	const resetIp = useMutation({
		mutationFn: (vars: { keyId: number; password: string }) =>
			keysService.resetIp(vars.keyId, vars.password),
		onSuccess: () => {
			toast.success("IP binding reset");
			invalidate();
		},
		onError: (err) =>
			toast.error("Couldn't reset IP", { description: errorMessage(err) }),
	});

	return { list, create, deleteKey, resetIp };
}
