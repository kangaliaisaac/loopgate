#!/bin/sh
# Claude Code PreToolUse hook (matcher: Bash). Refuses `git push` until, for the current HEAD, the
# repo's gates have passed (when it has a loopgate.json) and a pre-push review is recorded with no
# high finding. Exit 2 blocks the call and sends stderr to Claude; exit 0 lets it through. It only
# reads the records that ci-gate-runner and pre-push-review write; it starts nothing.
# It reads commands, not intent (ADR-0001): an alias or a shell trick can still hide a push.
input=$(cat)

# Cheap exit for every Bash call that is not a push.
case "$input" in *git*push*) ;; *) exit 0 ;; esac

if ! command -v jq >/dev/null 2>&1; then
	echo "Blocked: the pre-push gate needs jq on the PATH to read the hook input." >&2
	exit 2
fi

command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')
state="${LOOPGATE_STATE_DIR:-$HOME/.local/state/loopgate}"
sq="'"

# Checks the gate and review records of the repo at $1; exits 2 when the push must not go through.
check_repo() {
	head=$(git -C "$1" rev-parse HEAD 2>/dev/null) || {
		echo "Blocked: cannot read HEAD in '$1', so the gate and review records cannot be checked." >&2
		exit 2
	}
	top=$(git -C "$1" rev-parse --show-toplevel)
	short=$(printf '%s' "$head" | cut -c1-7)
	# The name the tools record under: the origin remote's last path segment, else the directory.
	repo=$(git -C "$1" remote get-url origin 2>/dev/null | sed -E 's|/+$||; s|\.git$||; s|.*[/:]||')
	repo=${repo:-$(basename "$top")}

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
}

# A path as given in the command, made absolute against the directory it is relative to.
resolve() {
	case "$1" in
	/*) printf '%s' "$1" ;;
	\~) printf '%s' "$HOME" ;;
	\~/*) printf '%s/%s' "$HOME" "${1#\~/}" ;;
	*) printf '%s/%s' "$2" "$1" ;;
	esac
}

# Fail closed: split the command into segments at ; & | ( ) and backticks (after joining backslash
# line continuations), and treat every segment that runs `git [global options] push` as a push.
# Only the options git accepts before a subcommand may sit between `git` and `push`, so a commit
# message that mentions pushing is not a push.
# shellcheck disable=SC2020 # six separators map to six newlines on purpose
segments=$(printf '%s\n' "$command" |
	awk '{ if (sub(/\\$/, "")) printf "%s", $0; else print }' |
	tr ';&|()`' '\n\n\n\n\n\n')
# A shell word: plain characters, backslash escapes and quoted runs in any mix (a="b c", with\ space).
val="(([^[:space:]\"${sq}\\\\]|\\\\.|\"[^\"]*\"|${sq}[^${sq}]*${sq})+)"
opt="(-C[[:space:]]+${val}|-c[[:space:]]+${val}|--(git-dir|work-tree|namespace|exec-path|super-prefix|attr-source|config-env)[[:space:]]+${val}|--[a-z-]+(=${val})?|-[pP])"
# `git` may follow any character but a word character, a dot or a hyphen (/usr/bin/git, \git, a quote),
# and may itself be quoted.
push_re="(^|[^[:alnum:]_.-])git[\"${sq}]?([[:space:]]+${opt})*[[:space:]]+[\"${sq}]?push[\"${sq}]?([^[:alnum:]_-]|\$)"
# `cd`, optionally after the words that open a branch or loop body; group 4 holds the path.
cd_re="^[[:space:]]*(((then|do|else|elif|if|while|until|!|command|builtin)[[:space:]]+)*)cd[[:space:]]+${val}"
dir_re="s/.*-C[[:space:]]+${val}.*/\\1/p"
# A path as the shell would read it: quotes and escapes removed.
unquote() { sed -E "s/[\"${sq}\\\\]//g"; }

cur=${cwd:-.}
targets=""
ambiguous=""
while IFS= read -r seg; do
	# `cd` moves where the following segments run.
	if printf '%s\n' "$seg" | grep -Eq "$cd_re"; then
		to=$(printf '%s\n' "$seg" | sed -nE "s/${cd_re}.*/\\4/p" | unquote)
		cur=$(resolve "$to" "$cur")
		continue
	fi
	printf '%s\n' "$seg" | grep -Eq "$push_re" || continue
	# A segment that only prints or searches for the text is not a push.
	printf '%s\n' "$seg" | grep -Eq '^[[:space:]]*(echo|printf|grep|rg|cat)[[:space:]]' && continue
	# Nothing is sent by a dry run; look only after `push`, and not at the value of -o.
	rest=$(printf '%s\n' "$seg" | awk -v re="$push_re" 'match($0, re) { print substr($0, RSTART + RLENGTH) }' |
		sed -E 's/(-o|--push-option)[[:space:]]+[^[:space:]]+//g')
	printf '%s\n' "$rest" | grep -Eq '(^|[[:space:]])(--dry-run|-n)([[:space:]]|$)' && continue
	dir=$(printf '%s\n' "$seg" | sed -nE "$dir_re" | unquote)
	# Several -C options compose, each relative to the one before: not worth resolving.
	[ "$(($(printf '%s\n' "$seg" | grep -o -e '-C[[:space:]]' | wc -l)))" -gt 1 ] && ambiguous=1
	targets="$targets
$(resolve "${dir:-.}" "$cur")"
done <<EOF
$segments
EOF
[ -n "$targets" ] || exit 0

# Where a push goes is not knowable from these, so refuse rather than guess. Always: a directory the
# hook cannot follow (pushd, popd, GIT_DIR, --git-dir, --work-tree, --chdir) or several -C. And a cd
# in a command that also has a group, a substitution ($( ), backticks, ${ }), sh -c or eval, since
# that cd may or may not reach the push. The check runs on one line, so a command over several lines
# is no different from one line. A cd with plain `&&` or `;` around it is followed segment by segment.
flat=$(printf '%s' "$command" | tr '\n' ' ')
dir_word='(^|[[:space:];&|(`"'"'"'])(pushd|popd)([[:space:]]|$)|GIT_DIR=|GIT_WORK_TREE=|--git-dir|--work-tree|--chdir'
cd_word='(^|[[:space:];&|(`"'"'"'])cd[[:space:]]'
if [ -n "$ambiguous" ] ||
	printf '%s\n' "$flat" | grep -Eq "$dir_word" ||
	{ printf '%s\n' "$flat" | grep -Eq "$cd_word" &&
		printf '%s\n' "$flat" | grep -Eq '[({`]|(^|[[:space:]])((ba|z|da)?sh[[:space:]]+-c|eval)([[:space:]]|$)'; }; then
	echo "Blocked: the repo this command pushes cannot be told (a cd mixed with a group, substitution, sh -c or eval; pushd, GIT_DIR, --git-dir, --chdir or several -C). Run the push on its own, with -C <dir> if needed." >&2
	exit 2
fi

# Every distinct target must pass.
done_dirs=""
while IFS= read -r target; do
	[ -n "$target" ] || continue
	# A variable or command substitution in the path is not expanded here.
	case "$target" in
	*'$'* | *'`'*)
		echo "Blocked: the repo this command pushes cannot be told ('$target' has a variable or substitution in it). Use a literal path." >&2
		exit 2
		;;
	esac
	case "
$done_dirs
" in *"
$target
"*) continue ;; esac
	done_dirs="$done_dirs
$target"
	check_repo "$target"
done <<EOF
$targets
EOF
exit 0
