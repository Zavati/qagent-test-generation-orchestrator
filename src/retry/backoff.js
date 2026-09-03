const DELAYS = [30, 60, 120, 300];
export function retryDelaySeconds(attemptCount) {
  const attempt = Math.max(1, Number(attemptCount) || 1);
  return DELAYS[Math.min(attempt - 1, DELAYS.length - 1)];
}
