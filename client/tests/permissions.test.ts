import { describe, expect, test } from "bun:test";
import {
	hasPermission,
	PERMISSION_FLAGS,
	PERMISSION_META,
} from "../src/config/permissions";

describe("hasPermission", () => {
	test("masters implicitly have every flag", () => {
		const master = { role: "master" };
		for (const flag of PERMISSION_FLAGS) {
			expect(hasPermission(master, flag)).toBe(true);
		}
	});
	test("regular users honor explicit flags", () => {
		const user = { role: "user", can_upload: true, can_view_admin: false };
		expect(hasPermission(user, "can_upload")).toBe(true);
		expect(hasPermission(user, "can_view_admin")).toBe(false);
		expect(hasPermission(user, "can_manage_users")).toBe(false);
	});
	test("null user has nothing", () => {
		expect(hasPermission(null, "can_upload")).toBe(false);
		expect(hasPermission(undefined, "can_view_admin")).toBe(false);
	});
});

describe("permission metadata", () => {
	test("every flag has metadata", () => {
		const metaKeys = new Set(PERMISSION_META.map((m) => m.key));
		for (const flag of PERMISSION_FLAGS) expect(metaKeys.has(flag)).toBe(true);
	});
});
