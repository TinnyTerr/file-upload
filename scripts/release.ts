#!/usr/bin/env bun
// Picks the next version from commit titles since the last v* tag, bumps the
// workspace package.json files, and prints the notes. Titles follow
// `{feat|fix|dep|...} {component}: {summary}`; a `!` after the type or a
// BREAKING line in the body means major, feat means minor, anything else patch.
//
//   bun scripts/release.ts            # dry run: prints version + notes
//   bun scripts/release.ts --write    # also rewrites package.json files
import { readFileSync, writeFileSync } from "node:fs";

const sh = (cmd: string[]) => {
	const r = Bun.spawnSync(cmd);
	return r.exitCode === 0 ? r.stdout.toString().trim() : "";
};

const FILES = ["package.json", "client/package.json", "server/package.json"];
const last = sh([
	"git",
	"describe",
	"--tags",
	"--match",
	"v[0-9]*",
	"--abbrev=0",
]);
const current = last
	? last.slice(1)
	: JSON.parse(readFileSync("package.json", "utf8")).version;

const range = last ? [`${last}..HEAD`] : ["HEAD"];
const raw = sh(["git", "log", ...range, "--format=%H%x1f%s%x1f%b%x1e"]);
const commits = raw
	.split("\x1e")
	.map((c) => c.trim())
	.filter(Boolean)
	.map((c) => {
		const [, subject = "", body = ""] = c.split("\x1f");
		return { subject, body };
	})
	.filter((c) => !c.subject.startsWith("release v"));

if (commits.length === 0) {
	console.error("nothing to release");
	process.exit(2);
}

let level: "major" | "minor" | "patch" = "patch";
for (const { subject, body } of commits) {
	const type = subject.split(/[\s(:!]/)[0];
	if (/^\w+[^:]*!:/.test(subject) || /^BREAKING/m.test(body)) level = "major";
	else if (type === "feat" && level !== "major") level = "minor";
}

const [maj, min, pat] = current.split(".").map(Number);
const next =
	level === "major"
		? `${maj + 1}.0.0`
		: level === "minor"
			? `${maj}.${min + 1}.0`
			: `${maj}.${min}.${pat + 1}`;

if (process.argv.includes("--write")) {
	for (const f of FILES) {
		const j = JSON.parse(readFileSync(f, "utf8"));
		j.version = next;
		writeFileSync(f, `${JSON.stringify(j, null, "\t")}\n`);
	}
}

const notes = commits.map((c) => `- ${c.subject}`).join("\n");
console.log(`VERSION=${next}`);
console.log(`LEVEL=${level}`);
console.log("---");
console.log(notes);
