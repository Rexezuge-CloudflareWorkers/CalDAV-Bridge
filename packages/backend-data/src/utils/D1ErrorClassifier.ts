const RETRYABLE_D1_PATTERNS: RegExp[] = [
  /database is locked/i,
  /database table is locked/i,
  /disk i\/o error/i,
  /too many sql variables/i,
  /internal error/i,
  /network/i,
  /timeout/i,
  /busy/i,
  /temporarily unavailable/i,
];

function isD1ErrorRetryable(message: string): boolean {
  return RETRYABLE_D1_PATTERNS.some((pattern) => pattern.test(message));
}

export { isD1ErrorRetryable };
