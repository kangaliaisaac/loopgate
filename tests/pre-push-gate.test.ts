import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recordPath } from '../src/gates/record.ts';

const HOOK = join(import.meta.dirname, '..', 'hooks', 'pre-push-gate.sh');

function git(dir: string, ...args: string[]): string {
	return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

/** A repo named `demo` (by its origin) with one commit, plus an empty state directory. */
function fixture(withConfig: boolean, dirName = 'demo') {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'hook-')));
	const repo = join(root, dirName);
	const state = join(root, 'state');
	mkdirSync(repo);
	mkdirSync(state);
	git(repo, 'init', '-q');
	git(repo, 'remote', 'add', 'origin', 'git@github.com:example-org/demo.git');
	if (withConfig) writeFileSync(join(repo, 'loopgate.json'), '{"gates":[]}');
	writeFileSync(join(repo, 'a.txt'), 'a');
	git(repo, 'add', '-A');
	git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init');
	return { repo, state, head: git(repo, 'rev-parse', 'HEAD') };
}

function run(command: string, cwd: string, state: string) {
	const result = spawnSync('sh', [HOOK], {
		input: JSON.stringify({ tool_input: { command }, cwd }),
		env: { ...process.env, LOOPGATE_STATE_DIR: state },
		encoding: 'utf8'
	});
	return { code: result.status, stderr: result.stderr };
}

const review = (head: string, high: number) =>
	`${JSON.stringify({ repo: 'demo', head: head.slice(0, 7), high })}\n`;

describe('pre-push-gate hook', () => {
	it('lets commands that are not a push through', () => {
		const { repo, state } = fixture(true);
		expect(run('git status', repo, state).code).toBe(0);
		expect(run('echo "git push" > notes.txt', repo, state).code).toBe(0);
		expect(run('git push --dry-run', repo, state).code).toBe(0);
	});

	it('catches pushes behind then/do, global options, env, substitutions and continuations', () => {
		const { repo, state } = fixture(true);
		for (const command of [
			'if true; then git push; fi',
			'for x in 1; do git push; done',
			'git -c core.pager=cat push origin main',
			'git --no-pager push',
			'git --git-dir /x push',
			'git "push"',
			'git push>/dev/null',
			'env X=1 git push',
			"bash -c 'git push'",
			'echo "$(git push origin main)"',
			'out=`git push`',
			'git -C . \\\n  push origin main',
			'git commit -m "add --dry-run flag" && git push',
			'git push && echo -n done',
			'git push --dry-run && git push',
			"printf 'main\\n' | xargs -n 1 git push origin",
			'nice -n 10 git push',
			'git push -o -n origin main'
		]) {
			expect(run(command, repo, state).code, command).toBe(2);
		}
	});

	it('blocks a push whose target cannot be told, rather than guessing', () => {
		const { repo, state } = fixture(true);
		for (const command of [
			'(cd /elsewhere && git push)',
			'pushd /elsewhere && git push',
			'GIT_DIR=/elsewhere/.git git push',
			'git --git-dir=/elsewhere/.git push'
		]) {
			const blocked = run(command, repo, state);
			expect(blocked.code, command).toBe(2);
			expect(blocked.stderr, command).toContain('cannot be told');
		}
	});

	it('does not mistake a mention of pushing for a push', () => {
		const { repo, state } = fixture(true);
		for (const command of [
			'git commit -m "Harden the push hook"',
			'git log --grep push',
			'echo "git push" | cat',
			'git push --dry-run origin main',
			'git push -n'
		]) {
			expect(run(command, repo, state).code, command).toBe(0);
		}
	});

	it('finds a repo at a path with a space, quoted either way, from another directory', () => {
		const { repo, state, head } = fixture(true, 'with space');
		writeFileSync(recordPath(state), JSON.stringify({ [repo]: { head, passedAt: 't' } }));
		writeFileSync(join(state, 'pre-push-review-log.jsonl'), review(head, 0));
		expect(run(`git -C "${repo}" push`, tmpdir(), state).code).toBe(0);
		expect(run(`git -C '${repo}' push`, tmpdir(), state).code).toBe(0);
		expect(run(`cd "${repo}" && git push`, tmpdir(), state).code).toBe(0);
	});

	it('checks every repo a command pushes, and a cd applies only to what follows it', () => {
		const { repo, state, head } = fixture(true);
		writeFileSync(recordPath(state), JSON.stringify({ [repo]: { head, passedAt: 't' } }));
		writeFileSync(join(state, 'pre-push-review-log.jsonl'), review(head, 0));
		const other = join(repo, '..', 'other');
		mkdirSync(other);
		expect(run(`git -C ${repo} push && git -C ${repo} push`, tmpdir(), state).code).toBe(0);
		expect(run(`git -C ${repo} push && git -C ${other} push`, tmpdir(), state).code).toBe(2);
		expect(run(`git push; cd ${other}; git push`, repo, state).code).toBe(2);
		expect(run(`cd ${other}; git -C ${repo} push`, tmpdir(), state).code).toBe(0);
	});

	it('judges a cd-then-push by the repo it moves into, resolved against the session directory', () => {
		const { repo, state, head } = fixture(true);
		writeFileSync(recordPath(state), JSON.stringify({ [repo]: { head, passedAt: 't' } }));
		writeFileSync(join(state, 'pre-push-review-log.jsonl'), review(head, 0));
		const other = join(repo, '..', 'other');
		mkdirSync(other);
		expect(run('git push', repo, state).code).toBe(0);
		expect(run('cd ../other && git push', repo, state).code).toBe(2);
		expect(run('cd ../demo && git push', other, state).code).toBe(0);
	});

	it('blocks a push in a repo with gates until they have passed for HEAD', () => {
		const { repo, state, head } = fixture(true);
		writeFileSync(join(state, 'pre-push-review-log.jsonl'), review(head, 0));
		const blocked = run('git push origin main', repo, state);
		expect(blocked.code).toBe(2);
		expect(blocked.stderr).toContain('the gates have not passed for demo');
		writeFileSync(recordPath(state), JSON.stringify({ [repo]: { head: 'older', passedAt: 't' } }));
		expect(run('git push', repo, state).code).toBe(2);
	});

	it('blocks when the review is missing or recorded a high finding', () => {
		const { repo, state, head } = fixture(true);
		writeFileSync(recordPath(state), JSON.stringify({ [repo]: { head, passedAt: 't' } }));
		const missing = run('git push', repo, state);
		expect(missing.code).toBe(2);
		expect(missing.stderr).toContain('no pre-push review is recorded for demo');
		writeFileSync(join(state, 'pre-push-review-log.jsonl'), review(head, 2));
		const high = run('cd . && git push', repo, state);
		expect(high.code).toBe(2);
		expect(high.stderr).toContain('2 high finding(s)');
	});

	it('blocks a dirty tree even when both records exist', () => {
		const { repo, state, head } = fixture(true);
		writeFileSync(recordPath(state), JSON.stringify({ [repo]: { head, passedAt: 't' } }));
		writeFileSync(join(state, 'pre-push-review-log.jsonl'), review(head, 0));
		writeFileSync(join(repo, 'b.txt'), 'b');
		const blocked = run('git push', repo, state);
		expect(blocked.code).toBe(2);
		expect(blocked.stderr).toContain('uncommitted changes');
	});

	it('allows the push when the gates passed and the review found no high finding', () => {
		const { repo, state, head } = fixture(true);
		writeFileSync(recordPath(state), JSON.stringify({ [repo]: { head, passedAt: 't' } }));
		writeFileSync(join(state, 'pre-push-review-log.jsonl'), `${review(head, 3)}${review(head, 0)}`);
		expect(run('git push origin main', repo, state).code).toBe(0);
		expect(run(`git -C ${repo} push`, tmpdir(), state).code).toBe(0);
	});

	it('checks only the review in a repo without a loopgate.json', () => {
		const { repo, state, head } = fixture(false);
		expect(run('git push', repo, state).code).toBe(2);
		writeFileSync(join(state, 'pre-push-review-log.jsonl'), review(head, 0));
		expect(run('git push', repo, state).code).toBe(0);
	});

	it('blocks when HEAD cannot be read', () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hook-')));
		const blocked = run('git push', dir, dir);
		expect(blocked.code).toBe(2);
		expect(blocked.stderr).toContain('cannot read HEAD');
	});
});
