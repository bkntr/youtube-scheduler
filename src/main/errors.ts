export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error
  const candidate = error as {
    code?: string | number
    message?: string
    response?: { status?: number; data?: { error?: { errors?: Array<{ reason?: string }>; message?: string } } }
  }
  const status = candidate.response?.status
  const reason = candidate.response?.data?.error?.errors?.[0]?.reason
  const message = candidate.response?.data?.error?.message ?? candidate.message ?? 'Unexpected error'
  if (status === 401 || reason === 'authError' || /invalid_grant/i.test(message)) {
    return new AppError('AUTH_REQUIRED', 'Your YouTube authorization expired. Reconnect and resume the batch.')
  }
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
    return new AppError('QUOTA_EXCEEDED', 'The YouTube API quota is exhausted. Resume after the quota resets.')
  }
  if (status === 403) return new AppError(reason ?? 'FORBIDDEN', message)
  if (status === 429) return new AppError('RATE_LIMITED', message, true)
  if (status && status >= 500) return new AppError(`YOUTUBE_${status}`, message, true)
  if (['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(String(candidate.code))) {
    return new AppError('NETWORK_ERROR', 'The network request failed.', true)
  }
  return new AppError(String(candidate.code ?? 'UNEXPECTED'), message)
}
