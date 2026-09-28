#!/usr/bin/env bash
# Stamps the commit that produced the current client build, so it's a `git tag`
# away to check whether a running deployment matches HEAD.
set -euo pipefail

if ! git rev-parse --git-dir >/dev/null 2>&1; then
	exit 0
fi

sha="$(git rev-parse --short HEAD)"
tag="build-${sha}"

if git rev-parse "$tag" >/dev/null 2>&1; then
	exit 0
fi

git tag "$tag"
echo "tagged ${tag}"
