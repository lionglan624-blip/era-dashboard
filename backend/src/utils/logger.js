function formatTimestamp() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.toISOString().replace('Z', '+09:00');
}

function createLogger(name) {
  const writeLog = (level, ...args) => {
    const timestamp = formatTimestamp();
    const message = args
      .map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
      .join(' ');
    const line = `[${timestamp}] [${level.toUpperCase()}] [${name}] ${message}\n`;

    if (level === 'error') {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  };

  return {
    info: (...args) => writeLog('info', ...args),
    warn: (...args) => writeLog('warn', ...args),
    error: (...args) => writeLog('error', ...args),
    debug: (...args) => writeLog('debug', ...args),
    flush: () => Promise.resolve(),
  };
}

// Pre-created loggers
export const serverLog = createLogger('server');
export const wsLog = createLogger('websocket');
export const claudeLog = createLogger('claude');
export const watcherLog = createLogger('watcher');

export function flushAll() {
  return Promise.resolve();
}

export { createLogger };
