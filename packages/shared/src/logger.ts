export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  ts: string;
  level: LogLevel;
  scope: string;
  msg: string;
  data?: Record<string, unknown>;
}

export type LogSink = (rec: LogRecord) => void;

/** Redactor hook; the security package installs a real one at startup. */
let redactor: (value: unknown) => unknown = (v) => v;
export function setLogRedactor(fn: (value: unknown) => unknown): void {
  redactor = fn;
}

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

export class Logger {
  constructor(
    private readonly scope: string,
    private readonly sinks: LogSink[] = [consoleSink],
    private readonly minLevel: LogLevel = (process.env.JARVIS_LOG_LEVEL as LogLevel) || 'info',
  ) {}

  child(scope: string): Logger {
    return new Logger(`${this.scope}:${scope}`, this.sinks, this.minLevel);
  }

  private emit(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (LEVELS.indexOf(level) < LEVELS.indexOf(this.minLevel)) return;
    const rec: LogRecord = {
      ts: new Date().toISOString(),
      level,
      scope: this.scope,
      msg: String(redactor(msg)),
      ...(data ? { data: redactor(data) as Record<string, unknown> } : {}),
    };
    for (const s of this.sinks) s(rec);
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.emit('debug', msg, data);
  }
  info(msg: string, data?: Record<string, unknown>): void {
    this.emit('info', msg, data);
  }
  warn(msg: string, data?: Record<string, unknown>): void {
    this.emit('warn', msg, data);
  }
  error(msg: string, data?: Record<string, unknown>): void {
    this.emit('error', msg, data);
  }
}

export const consoleSink: LogSink = (rec) => {
  const line = JSON.stringify(rec);
  if (rec.level === 'error' || rec.level === 'warn') console.error(line);
  else process.stdout.write(line + '\n');
};

export function memorySink(buffer: LogRecord[], max = 1000): LogSink {
  return (rec) => {
    buffer.push(rec);
    if (buffer.length > max) buffer.shift();
  };
}
