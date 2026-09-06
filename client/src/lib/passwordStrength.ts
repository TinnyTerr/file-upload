/**
 * A rough, dependency-free strength estimate: how many character classes are
 * present sets the guessing pool size, and length against that pool gives a
 * crude entropy-in-bits figure. Not a real cracking-time model -- just enough
 * to give a human a sense of "still weak" vs. "getting there" as they type.
 */

export type StrengthLabel = "weak" | "fair" | "good" | "strong";

export interface PasswordStrength {
	/** 0-100. */
	score: number;
	label: StrengthLabel;
}

/** Bits of entropy considered "full" on the 0-100 scale. */
const MAX_ENTROPY_BITS = 80;

export function passwordStrength(password: string): PasswordStrength {
	let poolSize = 0;
	if (/[a-z]/.test(password)) poolSize += 26;
	if (/[A-Z]/.test(password)) poolSize += 26;
	if (/[0-9]/.test(password)) poolSize += 10;
	if (/[^a-zA-Z0-9]/.test(password)) poolSize += 32;

	const entropyBits = password.length * Math.log2(Math.max(poolSize, 1));
	const score = Math.max(
		0,
		Math.min(100, Math.round((entropyBits / MAX_ENTROPY_BITS) * 100)),
	);

	const label: StrengthLabel =
		score < 25 ? "weak" : score < 50 ? "fair" : score < 75 ? "good" : "strong";

	return { score, label };
}
