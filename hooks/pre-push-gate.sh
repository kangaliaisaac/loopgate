#!/bin/sh
# Claude Code PreToolUse hook (matcher: Bash). Refuses `git push` until, for the current HEAD, the
# repo's gates have passed (when it has a loopgate.json) and a pre-push review is recorded with no
# high finding. Exit 2 blocks the call and sends stderr to Claude; exit 0 lets it through. It only
# reads the records that ci-gate-runner and pre-push-review write; it starts nothing.
input=$(cat)

# Cheap exit for every Bash call that is not a push.
case "$input" in *git*push*) ;; *) exit 0 ;; esac

if ! command -v jq >/dev/null 2>&1; then
	echo "Blocked: the pre-push gate needs jq on the PATH to read the hook input." >&2
	exit 2
fi

command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')

# A push at the start of a command or after ; & | ( or a newline, with optional -C <dir>.
push_re='(^|[;&|(]|&&|\|\|)[[:space:]]*git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+push([[:space:]]|$)'
printf '%s\n' "$command" | grep -Eq "$push_re" || exit 0

# Nothing is sent by a dry run.
case "$command" in *--dry-run*|*" -n "*) exit 0 ;; esac

dir=$(printf '%s\n' "$command" | sed -nE 's/.*git[[:space:]]+-C[[:space:]]+("([^"]+)"|([^[:space:]]+)).*/\2\3/p' | head -n 1)
dir=${dir:-$cwd}
dir=${dir:-.}

head=$(git -C "$dir" rev-parse HEAD 2>/dev/null) || {
	echo "Blocked: cannot read HEAD in '$dir', so the gate and review records cannot be checked." >&2
	exit 2
}
top=$(git -C "$dir" rev-parse --show-toplevel)
short=$(printf '%s' "$head" | cut -c1-7)
# The name the tools record under: the origin remote's last path segment, else the directory.
repo=$(git -C "$dir" remote get-url origin 2>/dev/null | sed -E 's|/+$||; s|\.git$||; s|.*[/:]||')
repo=${repo:-$(basename "$top")}
state="${LOOPGATE_STATE_DIR:-$HOME/.local/state/loopgate}"

# 1. Gates: only for a repo that declares them. Uncommitted changes mean the pass tested other code.
if [ -f "$top/loopgate.json" ]; then
	if [ -n "$(git -C "$top" status --porcelain)" ]; then
		echo "Blocked: $repo has uncommitted changes, so the gates would not test what is pushed. Commit, run ci-gate-runner from '$top', then push again." >&2
		exit 2
	fi
	passed=""
	if [ -f "$state/ci-gate-pass.json" ]; then
		passed=$(jq -r --arg top "$top" '.[$top].head // empty' "$state/ci-gate-pass.json" 2>/dev/null)
	fi
	if [ "$passed" != "$head" ]; then
		echo "Blocked: the gates have not passed for $repo at $short. Run ci-gate-runner from '$top' (it can take minutes: run it in the background and wait), then push again." >&2
		exit 2
	fi
fi

# 2. Review: the latest record for this repo at this HEAD decides.
log="$state/pre-push-review-log.jsonl"
verdict=""
if [ -f "$log" ]; then
	verdict=$(jq -rc --arg repo "$repo" --arg head "$short" \
		'select(.repo == $repo and (.head[0:7]) == $head) | .high' "$log" 2>/dev/null | tail -n 1)
fi

if [ -z "$verdict" ]; then
	echo "Blocked: no pre-push review is recorded for $repo at $short. Run the pre-push-review skill (prepare, review, handle the findings, log), then push again." >&2
	exit 2
fi
if [ "$verdict" != "0" ]; then
	echo "Blocked: the latest pre-push review of $repo at $short recorded $verdict high finding(s). Fix them, commit, run the gates and the review again; or ask the owner to override." >&2
	exit 2
fi
exit 0
