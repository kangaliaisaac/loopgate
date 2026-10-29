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

# Fail closed: any command segment (split at ; & | and newlines) that runs `git ... push` is a push,
# whatever sits before it (then, do, env, a quoted -C path) or between git and push (-c k=v, --no-pager).
# Segments that only print or search for the text are not.
# shellcheck disable=SC2020 # three separators map to three newlines on purpose
segments=$(printf '%s\n' "$command" | tr ';&|' '\n\n\n')
push_re='(^|[[:space:]"'"'"'({])git[[:space:]]+([^[:space:]]+[[:space:]]+)*push([[:space:]"'"'"')}]|$)'
pushes=$(printf '%s\n' "$segments" | grep -E "$push_re" | grep -Ev '^[[:space:]]*(echo|printf|grep|rg|cat)[[:space:]]')
[ -n "$pushes" ] || exit 0

# Nothing is sent by a dry run, but only a push segment that is itself a dry run is skipped.
pushes=$(printf '%s\n' "$pushes" | grep -Ev '[[:space:]](--dry-run|-n)([[:space:]]|$)')
[ -n "$pushes" ] || exit 0

# The repo being pushed: -C of the push, else the target of a cd before it, else the session directory.
dir=$(printf '%s\n' "$pushes" | sed -nE 's/.*-C[[:space:]]+("([^"]+)"|([^[:space:]]+)).*/\2\3/p' | head -n 1)
if [ -z "$dir" ]; then
	dir=$(printf '%s\n' "$segments" | sed -nE 's/^[[:space:]]*cd[[:space:]]+("([^"]+)"|([^[:space:]]+)).*/\2\3/p' | head -n 1)
fi
case "$dir" in
'') dir=${cwd:-.} ;;
/*) ;;
*) dir="${cwd:-.}/$dir" ;;
esac

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
