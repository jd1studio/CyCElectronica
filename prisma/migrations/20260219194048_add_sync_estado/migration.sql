-- CreateTable
CREATE TABLE "SyncEstado" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "estado" TEXT NOT NULL DEFAULT 'idle',
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "paginaActual" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "iniciadoEn" DATETIME,
    "terminadoEn" DATETIME
);
