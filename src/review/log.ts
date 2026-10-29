import type { ReviewModel } from './classify.ts';

export interface ReviewLogEntry {
	ts: string;
	repo: string;
	head: string;
	model: ReviewModel;
	lines: number;
	high: number;
	medium: number;
	low: number;
}

/**
 * One line per review, numbers only, so the owner can see over time how often a review found
 * something. The push hook reads `high` from the latest line for a commit.
 */
export function logLine(entry: ReviewLogEntry): string {
	return `${JSON.stringify(entry)}\n`;
}

export function logPath(stateDir: string): string {
	return `${stateDir}/pre-push-review-log.jsonl`;
}
