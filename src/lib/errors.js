export class OrchestratorError extends Error {
  constructor(code, message, { status = 500, retryable = false, details = null, cause = null } = {}) {
    super(message);
    this.name = 'OrchestratorError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    if (details) this.details = details;
    if (cause) this.cause = cause;
  }
}

export function asOrchestratorError(error) {
  if (error instanceof OrchestratorError) return error;
  return new OrchestratorError(
    error?.code || 'PROJECT_TEST_DESIGN_GENERATION_INTERNAL_ERROR',
    error?.publicMessage || error?.message || 'Project Test Design Generation failed.',
    { status: error?.status || 500, retryable: error?.retryable === true, cause: error },
  );
}

export function safeErrorMessage(error) {
  const value = String(error?.publicMessage || error?.message || 'Unexpected generation failure.');
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(authorization|cookie|set-cookie|password|passwd|token|access[_ -]?token|refresh[_ -]?token|secret|api[_ -]?key|x-api-key)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/([?&](?:token|access_token|refresh_token|api_key|key|secret|password)=)[^&#\s]+/gi, '$1[REDACTED]')
    .slice(0, 500);
}
