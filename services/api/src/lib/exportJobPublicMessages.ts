/**
 * Safe, API-client-facing copy for export job failures (no raw DB / stack / storage text).
 * Used by dashboard export routes and v1 API-key export detail.
 */

export function publicExportFailureSummary(
  status: string,
  errorCode: string | null | undefined
): string | null {
  if (status !== 'FAILED' && status !== 'CANCELED') return null;
  switch (errorCode) {
    case 'RESTORE_REQUIRED':
      return 'Cold archive data must be restored before this export can complete.';
    case 'CLIENT_DISCONNECTED':
      return 'The export stream stopped because the connection closed before it finished.';
    case 'EXPORT_TOO_LARGE':
      return 'This export was larger than the dashboard download buffer allows.';
    case 'STREAM_ERROR':
      return 'An error occurred while generating the export stream.';
    default:
      if (status === 'CANCELED') {
        return 'The export stream was interrupted or cancelled before completion.';
      }
      return 'Export stream did not complete successfully.';
  }
}

/** Short, stable guidance for developers (no internal paths). */
export function publicExportRetryHint(
  status: string,
  errorCode: string | null | undefined
): string | null {
  if (status !== 'FAILED' && status !== 'CANCELED') return null;
  switch (errorCode) {
    case 'RESTORE_REQUIRED':
      return 'Restore required cold archives, then create a new export job and download again.';
    case 'EXPORT_TOO_LARGE':
      return 'Narrow filters or row limit, or use a client that supports larger streamed responses.';
    case 'CLIENT_DISCONNECTED':
      return 'Retry the download and keep the connection open until the stream completes.';
    case 'STREAM_ERROR':
      return 'Create a new export job and retry; include errorCode when contacting support.';
    default:
      return 'Create a new export job and retry.';
  }
}
