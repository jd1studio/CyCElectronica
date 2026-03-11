-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SyncEstado" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "estado" TEXT NOT NULL DEFAULT 'idle',
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "totalActualizados" INTEGER NOT NULL DEFAULT 0,
    "paginaActual" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "iniciadoEn" DATETIME,
    "terminadoEn" DATETIME
);
INSERT INTO "new_SyncEstado" ("error", "estado", "id", "iniciadoEn", "paginaActual", "terminadoEn", "totalItems") SELECT "error", "estado", "id", "iniciadoEn", "paginaActual", "terminadoEn", "totalItems" FROM "SyncEstado";
DROP TABLE "SyncEstado";
ALTER TABLE "new_SyncEstado" RENAME TO "SyncEstado";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
