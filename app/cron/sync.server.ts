import cron from "node-cron";
import fs from "fs";
import path from "path";
import { ejecutarSyncCompleto } from "../services/siesa.server";
import { logInfo, logError } from "../services/logger.server";
import prisma from "../db.server";

// Singleton guard: evita registrar el cron más de una vez (HMR safe)
let initialized = false;

async function correrSync(): Promise<void> {
  const estado = await prisma.syncEstado.findUnique({ where: { id: "singleton" } });

  if (estado?.estado === "en_progreso") {
    logInfo("Cron disparado pero ya hay un sync en progreso. Se omite esta ejecución.");
    return;
  }

  const iniciadoEn = new Date();

  await prisma.syncEstado.upsert({
    where: { id: "singleton" },
    update: { estado: "en_progreso", error: null, totalItems: 0, totalActualizados: 0, paginaActual: 0, iniciadoEn, terminadoEn: null },
    create: { id: "singleton", estado: "en_progreso", iniciadoEn },
  });

  try {
    const { totalItems, totalActualizados } = await ejecutarSyncCompleto();

    await prisma.syncEstado.update({
      where: { id: "singleton" },
      data: { estado: "completado", totalItems, totalActualizados, terminadoEn: new Date() },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`Sync falló: ${msg}`);

    await prisma.syncEstado.update({
      where: { id: "singleton" },
      data: { estado: "error", error: msg, terminadoEn: new Date() },
    });
  }
}

async function limpiarEstadoAtascado(): Promise<void> {
  const estado = await prisma.syncEstado.findUnique({ where: { id: "singleton" } });
  if (estado?.estado === "en_progreso") {
    await prisma.syncEstado.update({
      where: { id: "singleton" },
      data: { estado: "idle", error: "Servidor reiniciado durante sync anterior", terminadoEn: new Date() },
    });
    logInfo("Estado atascado detectado al arrancar — reseteado a idle.");
  }
}

function limpiarLogsAntiguos(): void {
  const logsDir = path.resolve("logs");
  if (!fs.existsSync(logsDir)) return;

  const ayer = new Date();
  ayer.setDate(ayer.getDate() - 1);
  ayer.setHours(0, 0, 0, 0);

  const archivos = fs.readdirSync(logsDir).filter((f) => f.startsWith("sync-") && f.endsWith(".log"));

  for (const archivo of archivos) {
    const fechaStr = archivo.replace("sync-", "").replace(".log", ""); // YYYY-MM-DD
    const fechaArchivo = new Date(fechaStr);
    if (isNaN(fechaArchivo.getTime())) continue;

    if (fechaArchivo < ayer) {
      fs.unlinkSync(path.join(logsDir, archivo));
      logInfo(`Log eliminado: ${archivo}`);
    }
  }
}

export function initCron(): void {
  if (initialized) return;
  initialized = true;

  limpiarEstadoAtascado().catch((err) => {
    logError(`Error al limpiar estado atascado: ${err instanceof Error ? err.message : String(err)}`);
  });

  const expresion = process.env.SYNC_CRON ?? "0 */3 * * *";

  if (!cron.validate(expresion)) {
    logError(`SYNC_CRON inválido: "${expresion}". El cron NO fue registrado.`);
    return;
  }

  cron.schedule(expresion, () => {
    correrSync().catch((err) => {
      logError(`Error no capturado en correrSync: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  // Limpieza de logs: cada 5 días a medianoche
  cron.schedule("0 0 */5 * *", () => {
    try {
      limpiarLogsAntiguos();
    } catch (err) {
      logError(`Error al limpiar logs: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  logInfo(`Cron registrado con expresión: ${expresion}`);
}

// Auto-inicializar al importar este módulo
initCron();
