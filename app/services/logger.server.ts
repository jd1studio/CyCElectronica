import fs from "fs";
import path from "path";

function getLogPath(): string {
  const fecha = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const logsDir = path.resolve("logs");
  fs.mkdirSync(logsDir, { recursive: true });
  return path.join(logsDir, `sync-${fecha}.log`);
}

function escribir(nivel: string, mensaje: string): void {
  const ts = new Date().toISOString();
  const linea = `[${ts}] [${nivel}] ${mensaje}\n`;
  fs.appendFileSync(getLogPath(), linea, "utf8");
  // También en consola para poder ver el progreso en tiempo real
  console.log(`[SYNC] [${nivel}] ${mensaje}`);
}

export function logInfo(mensaje: string): void {
  escribir("INFO", mensaje);
}

export function logError(mensaje: string): void {
  escribir("ERROR", mensaje);
}
