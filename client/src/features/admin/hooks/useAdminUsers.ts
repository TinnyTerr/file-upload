import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/config/api";
import { adminService } from "../services/adminService";
import type { UserPermissions } from "../types";

const USERS_KEY = ["admin", "users"] as const;

export function useAdminUsers() {
	const qc = useQueryClient();
	const invalidate = () => {
		qc.invalidateQueries({ queryKey: USERS_KEY });
		qc.invalidateQueries({ queryKey: ["admin", "storage"] });
	};

	const list = useQuery({ queryKey: USERS_KEY, queryFn: adminService.users });

	const create = useMutation({
		mutationFn: (body: {
			username: string;
			password: string;
			role: string;
			can_upload: boolean;
		}) => adminService.createUser(body),
		onSuccess: () => {
			toast.success("User created");
			invalidate();
		},
		onError: (err) =>
			toast.error("Couldn't create user", { description: errorMessage(err) }),
	});

	const update = useMutation({
		mutationFn: (vars: {
			id: number;
			username?: string;
			password?: string;
			role?: string;
			mfa_required?: boolean;
		}) => adminService.updateUser(vars.id, vars),
		onSuccess: () => {
			toast.success("User updated");
			invalidate();
		},
		onError: (err) =>
			toast.error("Couldn't update user", { description: errorMessage(err) }),
	});

	const remove = useMutation({
		mutationFn: (id: number) => adminService.deleteUser(id),
		onSuccess: () => {
			toast.success("User deleted");
			invalidate();
		},
		onError: (err) =>
			toast.error("Couldn't delete user", { description: errorMessage(err) }),
	});

	const setPermissions = useMutation({
		mutationFn: (vars: { id: number; permissions: Partial<UserPermissions> }) =>
			adminService.setPermissions(vars.id, vars.permissions),
		onSuccess: () => {
			toast.success("Permissions updated");
			invalidate();
		},
		onError: (err) =>
			toast.error("Couldn't update permissions", {
				description: errorMessage(err),
			}),
	});

	return { list, create, update, remove, setPermissions };
}
