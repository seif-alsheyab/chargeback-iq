// Minimal structured logger.
//
// JSON lines rather than prose: log aggregators can filter and search
// structured fields, whereas free text has to be parsed with fragile regex.
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[process.env.LOG_LEVEL ?? 'info'] ?? LEVELS.info;

function emit(level, message, fields = {}) {
  if (LEVELS[level] > threshold) return;
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level, message, ...fields })}\n`
  );
}

export const logger = {
  error: (m, f) => emit('error', m, f),
  warn: (m, f) => emit('warn', m, f),
  info: (m, f) => emit('info', m, f),
  debug: (m, f) => emit('debug', m, f),
};
