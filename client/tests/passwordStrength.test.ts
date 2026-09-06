import { describe, expect, test } from "bun:test";
import { passwordStrength } from "../src/lib/passwordStrength";

describe("passwordStrength", () => {
	test("an empty password scores zero", () => {
		expect(passwordStrength("").score).toBe(0);
	});

	test("a short single-class password is weak", () => {
		expect(passwordStrength("abc").label).toBe("weak");
	});

	test("length alone raises the score", () => {
		const short = passwordStrength("password");
		const long = passwordStrength("passwordpasswordpassword");
		expect(long.score).toBeGreaterThan(short.score);
	});

	test("mixing character classes raises the score at the same length", () => {
		const lower = passwordStrength("abcdefgh");
		const mixed = passwordStrength("aB3!fgh$");
		expect(mixed.score).toBeGreaterThan(lower.score);
	});

	test("a long, mixed-class password is strong", () => {
		const { label, score } = passwordStrength("Tr0ub4dor&3-correct-horse!");
		expect(label).toBe("strong");
		expect(score).toBe(100);
	});

	test("score is always within [0, 100]", () => {
		for (const pw of ["", "a", "a".repeat(500), "!@#$%^&*()"]) {
			const { score } = passwordStrength(pw);
			expect(score).toBeGreaterThanOrEqual(0);
			expect(score).toBeLessThanOrEqual(100);
		}
	});
});
