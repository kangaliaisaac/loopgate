# loopgate

Gates and reviews for AI-assisted changes: a CI gate runner, a pre-push review, review triage, a push hook and a reusable GitHub review workflow. Read `intent.md` (what and why) and `spec.md` (the contract) first.

## Commands

```
npm ci
npx prettier --check .      # format (npx prettier --write . to fix)
npm run typecheck           # tsc --noEmit, strict
npm run build               # the library, to dist/
npm test                    # vitest with coverage; the thresholds are 100%
npm audit --audit-level=high
shellcheck hooks/pre-push-gate.sh
```

`node bin/ci-gate-runner.ts` runs the same gates from `loopgate.json`.

## Rules

- TypeScript on Node 24+, run directly with no build step (`erasableSyntaxOnly`: no enums, namespaces or parameter properties). Tabs, single quotes, no trailing commas, `printWidth` 100.
- Functional core, thin I/O edges. Logic lives in `src/` as pure functions that take their dependencies (exec, clock, filesystem) as arguments. `bin/` only wires the real ones in.
- No premature abstraction. Use the standard library first; a runtime dependency needs a reason in the PR.
- Functions about 30 statements, at most 5 arguments, one responsibility per module. Comments say why, not what.
- Every behaviour has a test, and coverage stays at 100%. A test that passes without testing anything is a defect.
- The public library surface is `src/index.ts`; changing it is a breaking change and fails `tests/index.test.ts` on purpose.
- Agents are read-only: their `tools` are `Read`, `Grep`, `Glob` and nothing else. A test enforces it.
- Never commit secrets, tokens or personal data. Commits use the GitHub noreply address.
- One feature per step, and each step ends mergeable. The owner reviews and merges every PR.
