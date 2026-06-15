export type LogLevel = "INFO" | "WARN" | "ERROR";

export interface LogEntry {
  id: string;
  level: LogLevel;
  message: string;
  createdAt: string;
  transactionId?: string;
}

export class LoggerService {
  private entries: LogEntry[] = [];

  info(message: string, transactionId?: string) {
    this.add("INFO", message, transactionId);
  }

  warn(message: string, transactionId?: string) {
    this.add("WARN", message, transactionId);
  }

  error(message: string, transactionId?: string) {
    this.add("ERROR", message, transactionId);
  }

  getRecentEntries(limit = 100) {
    return this.entries.slice(-limit);
  }

  private add(level: LogLevel, message: string, transactionId?: string) {
    this.entries.push({
      id: crypto.randomUUID(),
      level,
      message,
      transactionId,
      createdAt: new Date().toISOString(),
    });
  }
}

export const logger = new LoggerService();
