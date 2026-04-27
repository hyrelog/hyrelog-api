import pino from 'pino';
import { loadConfig } from './config.js';

let loggerInstance: pino.Logger | null = null;

export function getLogger(): pino.Logger {
  if (loggerInstance) {
    return loggerInstance;
  }

  const config = loadConfig();

  // In development, use sync stdout so logs appear in PowerShell/Cursor (no pino-pretty worker).
  const isDev = config.nodeEnv === 'development';
  const dest = isDev ? pino.destination({ dest: 1, sync: true, minLength: 0 }) : undefined;

  loggerInstance = dest
    ? pino({ level: config.logLevel }, dest)
    : pino({ level: config.logLevel });

  return loggerInstance;
}

