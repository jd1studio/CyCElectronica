import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigation, useSubmit, useRevalidator } from "react-router";
import { useEffect } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ejecutarSyncCompleto } from "../services/siesa.server";
import { logInfo } from "../services/logger.server";
import cronstrue from "cronstrue/i18n";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const estado = await prisma.syncEstado.findUnique({ where: { id: "singleton" } });
  const cronExpr = process.env.SYNC_CRON ?? "0 */3 * * *";

  let cronLegible: string;
  try {
    cronLegible = cronstrue.toString(cronExpr, { locale: "es", use24HourTimeFormat: true });
  } catch {
    cronLegible = cronExpr;
  }

  return {
    estado: estado?.estado ?? "idle",
    totalItems: estado?.totalItems ?? 0,
    totalActualizados: estado?.totalActualizados ?? 0,
    paginaActual: estado?.paginaActual ?? 0,
    error: estado?.error ?? null,
    iniciadoEn: estado?.iniciadoEn?.toISOString() ?? null,
    terminadoEn: estado?.terminadoEn?.toISOString() ?? null,
    cronExpr,
    cronLegible,
  };
};

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------
export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);

  const estadoActual = await prisma.syncEstado.findUnique({ where: { id: "singleton" } });

  if (estadoActual?.estado === "en_progreso") {
    return { error: "Ya hay una sincronización en progreso." };
  }

  const iniciadoEn = new Date();

  await prisma.syncEstado.upsert({
    where: { id: "singleton" },
    update: { estado: "en_progreso", error: null, totalItems: 0, totalActualizados: 0, paginaActual: 0, iniciadoEn, terminadoEn: null },
    create: { id: "singleton", estado: "en_progreso", iniciadoEn },
  });

  logInfo("Sync manual iniciado desde UI");

  ejecutarSyncCompleto()
    .then(async ({ totalItems, totalActualizados }) => {
      await prisma.syncEstado.update({
        where: { id: "singleton" },
        data: { estado: "completado", totalItems, totalActualizados, terminadoEn: new Date() },
      });
    })
    .catch(async (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      await prisma.syncEstado.update({
        where: { id: "singleton" },
        data: { estado: "error", error: msg, terminadoEn: new Date() },
      });
    });

  return { iniciado: true };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatFecha(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" });
}

function calcularDuracion(inicio: string | null, fin: string | null): string {
  if (!inicio) return "—";
  const desde = new Date(inicio).getTime();
  const hasta = fin ? new Date(fin).getTime() : Date.now();
  const segs = Math.floor((hasta - desde) / 1000);
  if (segs < 60) return `${segs}s`;
  const mins = Math.floor(segs / 60);
  const resto = segs % 60;
  return resto > 0 ? `${mins}m ${resto}s` : `${mins}m`;
}

function badgeTone(estado: string): "success" | "warning" | "critical" | "info" {
  switch (estado) {
    case "completado": return "success";
    case "en_progreso": return "warning";
    case "error": return "critical";
    default: return "info";
  }
}

function badgeLabel(estado: string): string {
  switch (estado) {
    case "completado": return "Completado";
    case "en_progreso": return "En progreso";
    case "error": return "Error";
    default: return "Sin ejecutar";
  }
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
export default function SyncPage() {
  const data = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const { revalidate } = useRevalidator();

  const enProgreso = data.estado === "en_progreso";
  const enviando = navigation.state === "submitting";

  useEffect(() => {
    if (!enProgreso) return;
    const id = setInterval(() => revalidate(), 3000);
    return () => clearInterval(id);
  }, [enProgreso, revalidate]);

  function handleSync() {
    submit({}, { method: "post" });
  }

  return (
    <s-page heading="Sincronización de Inventarios">

      {/* ── Estado actual ── */}
      <s-section heading="Estado actual">
        <s-badge tone={badgeTone(data.estado)}>
          {badgeLabel(data.estado)}
        </s-badge>
        <ul style={{ paddingLeft: "20px", margin: "12px 0 0 0", lineHeight: "2" }}>
          <li>Productos SIESA: <strong>{data.totalItems.toLocaleString("es-CO")}</strong></li>
          <li>Actualizados en Shopify: <strong>{data.totalActualizados.toLocaleString("es-CO")}</strong></li>
          <li>{enProgreso ? "Página actual" : "Páginas consultadas"}: <strong>{data.paginaActual > 0 ? data.paginaActual : "—"}</strong></li>
          <li>Duración: <strong>{calcularDuracion(data.iniciadoEn, data.terminadoEn)}</strong></li>
          <li>Iniciado: <strong>{formatFecha(data.iniciadoEn)}</strong></li>
          <li>Finalizado: <strong>{formatFecha(data.terminadoEn)}</strong></li>
        </ul>
        {data.error && (
          <div style={{ marginTop: "12px", padding: "12px", background: "#fff4f4", borderRadius: "8px", color: "#d72c0d" }}>
            <strong>Error:</strong> {data.error}
          </div>
        )}
      </s-section>

      {/* ── Programación automática ── */}
      <s-section heading="Programación automática:">
        <ul style={{ paddingLeft: "20px", margin: "4px 0 0 0", lineHeight: "2" }}>
          <li>{data.cronLegible} <span style={{ color: "#6d7175" }}>({data.cronExpr})</span></li>
        </ul>
      </s-section>

      {/* ── Sync manual ── */}
      <s-section heading="Sincronización manual:">
        <s-button
          variant="primary"
          disabled={enProgreso || enviando}
          onClick={handleSync}
        >
          {enviando ? "Iniciando..." : enProgreso ? "En progreso..." : "Sincronizar ahora"}
        </s-button>
        <ul style={{ paddingLeft: "20px", margin: "8px 0 0 0", lineHeight: "2", color: "#6d7175" }}>
          <li>Fuerza una sincronización inmediata sin esperar al horario programado. (No detiene una sincronización en curso)</li>
        </ul>
      </s-section>

    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(new Error("Error en la página de sincronización"));
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
