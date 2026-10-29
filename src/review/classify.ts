/**
 * Which model reviews a branch: the stronger one by default, the cheaper one for a small diff that
 * touches no decision record, rule, workflow or definition. A miss on those costs more than the
 * model difference saves.
 */
import type { SensitivePath } from '../gates/config.ts';

export interface ChangedFile {
	path: string;
	added: number;
	deleted: number;
}

export type ReviewModel = 'opus' | 'sonnet';

export interface Classification {
	model: ReviewModel;
	lines: number;
	/** Why Opus was chosen (empty for Sonnet). */
	reasons: string[];
	/** Big enough that the review is expensive and may miss things: split it or ask the owner. */
	large: boolean;
}

/** Below this many changed lines a diff with no sensitive path goes to Sonnet. */
export const SMALL_DIFF_LINES = 200;
export const LARGE_DIFF_LINES = 1500;

/**
 * Paths where a mistake is not caught by tests or CI: decisions, rules, workflows, definitions. A
 * repo adds its own (migrations, contracts) in `sensitivePaths` of its `loopgate.json`.
 */
const SENSITIVE: SensitivePath[] = [
	{ pattern: /(^|\/)(docs\/)?adr\//, label: 'a decision record' },
	{ pattern: /(^|\/)CLAUDE\.md$/, label: 'CLAUDE.md' },
	{ pattern: /^\.github\//, label: 'a CI workflow or repo setting' },
	{ pattern: /^(agents|skills|hooks)\//, label: 'an agent, skill or hook definition' }
];

export function classify(files: ChangedFile[], extra: SensitivePath[] = []): Classification {
	const lines = files.reduce((sum, f) => sum + f.added + f.deleted, 0);
	const reasons: string[] = [];
	const touched = new Set<string>();
	for (const file of files) {
		const hit = [...SENSITIVE, ...extra].find((s) => s.pattern.test(file.path));
		if (hit !== undefined && !touched.has(hit.label)) {
			touched.add(hit.label);
			reasons.push(`touches ${hit.label} (${file.path})`);
		}
	}
	if (lines >= SMALL_DIFF_LINES)
		reasons.push(`${lines} changed lines (Sonnet only below ${SMALL_DIFF_LINES})`);
	return {
		model: reasons.length === 0 ? 'sonnet' : 'opus',
		lines,
		reasons,
		large: lines >= LARGE_DIFF_LINES
	};
}

/** `git diff --numstat` output. Binary files (`-`) count as zero lines. */
export function parseNumstat(output: string): ChangedFile[] {
	return output
		.split('\n')
		.filter((line) => line !== '')
		.map((line) => {
			const [added = '', deleted = '', ...path] = line.split('\t');
			return { path: path.join('\t'), added: Number(added) || 0, deleted: Number(deleted) || 0 };
		});
}
