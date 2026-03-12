import { logInfo, logError } from "./logger.server";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { unauthenticated } from "../shopify.server";
import prisma from "../db.server";

// ---------------------------------------------------------------------------
// Tipos de respuesta SIESA
// ---------------------------------------------------------------------------
interface SiesaItem {
  f120_referencia: string;
  f400_cant_existencia_1: number;
  f150_id: string;
  f120_id_cia: number;
  f120_id: string | number;
  [key: string]: unknown;
}

interface SiesaResponse {
  codigo: number;
  mensaje: string;
  detalle: {
    Table: SiesaItem[];
  };
}

// ---------------------------------------------------------------------------
// GraphQL — consulta inventoryItems por SKU (batch)
// ---------------------------------------------------------------------------
const QUERY_INVENTORY_BY_SKU = `#graphql
  query InventoryItemsBySku($skuQuery: String!, $first: Int!) {
    inventoryItems(first: $first, query: $skuQuery) {
      edges {
        node {
          id
          sku
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// GraphQL — mutación inventorySetQuantities
// ---------------------------------------------------------------------------
const MUTATION_SET_QUANTITIES = `#graphql
  mutation SetInventoryQuantities($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup {
        changes {
          name
          delta
          quantityAfterChange
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Obtener cliente admin desde sesión offline guardada en DB
// ---------------------------------------------------------------------------
async function obtenerAdminClient(): Promise<AdminApiContext> {
  const session = await prisma.session.findFirst({ where: { isOnline: false } });
  if (!session) {
    throw new Error("No se encontró sesión offline de Shopify. Abre la app en el admin para iniciar sesión.");
  }
  const { admin } = await unauthenticated.admin(session.shop);
  return admin;
}

// ---------------------------------------------------------------------------
// Construcción de URL paginada
// ---------------------------------------------------------------------------
function buildSiesaUrl(numPag: number): string {
  const base = process.env.URLSIESAINV!;
  const paginacionRaw = process.env.PAGINACION ?? "numPag=1|tamPag=100";
  const tamPag = paginacionRaw.split("|").find((p) => p.startsWith("tamPag="))?.split("=")[1] ?? "100";

  const params = new URLSearchParams({
    idCompania: process.env.IDCOMPANIA ?? "",
    descripcion: process.env.DESCRIPCION ?? "",
    paginacion: `numPag=${numPag}|tamPag=${tamPag}`,
    parametros: process.env.PARAMETROS ?? "",
  });

  return `${base}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Headers SIESA
// ---------------------------------------------------------------------------
function buildHeaders(): Record<string, string> {
  return {
    "CLIENT_ID": process.env.CLIENT_ID ?? "",
    "CONNIKEY": process.env.CONNIKEY ?? "",
    "CONNITOKEN": process.env.CONNITOKEN ?? "",
    "Content-Type": "application/json",
  };
}

// ---------------------------------------------------------------------------
// Procesar una página:
//   1. Query Shopify en lotes de 20 SKUs para obtener inventoryItemId
//   2. Una sola mutation por página con todos los items encontrados
// ---------------------------------------------------------------------------
async function procesarItems(items: SiesaItem[], admin: AdminApiContext): Promise<number> {
  const locationId = process.env.IDLOCATION!;
  const SKU_BATCH = 20;

  // Mapa SKU → cantidad desde SIESA
  const siesaMap = new Map<string, number>();
  for (const item of items) {
    siesaMap.set(String(item.f120_id).trim(), item.f400_cant_existencia_1);
  }

  const skus = Array.from(siesaMap.keys());
  const quantities: { inventoryItemId: string; locationId: string; quantity: number }[] = [];

  // Consultar Shopify en lotes de 20 SKUs
  for (let i = 0; i < skus.length; i += SKU_BATCH) {
    const batch = skus.slice(i, i + SKU_BATCH);
    const skuQuery = batch.map((sku) => `sku:'${sku}'`).join(" OR ");

    const loteLabel = `Lote [${i}–${i + batch.length - 1}]`;

    // Reintento con backoff en caso de throttle de Shopify
    let edges: { node: { id: string; sku: string } }[] = [];
    let intentos = 0;
    const MAX_INTENTOS = 3;

    while (intentos < MAX_INTENTOS) {
      intentos++;

      const resp = await admin.graphql(QUERY_INVENTORY_BY_SKU, {
        variables: { skuQuery, first: batch.length },
      });

      const json = (await resp.json()) as {
        data?: {
          inventoryItems?: {
            edges: { node: { id: string; sku: string } }[];
          };
        };
        errors?: { message: string }[];
        extensions?: {
          cost?: {
            throttleStatus?: {
              currentlyAvailable: number;
              restoreRate: number;
            };
          };
        };
      };

      // Detectar errores GraphQL (throttle u otro)
      if (json.errors && json.errors.length > 0) {
        const errMsg = json.errors.map((e) => e.message).join("; ");
        const throttleStatus = json.extensions?.cost?.throttleStatus;
        if (throttleStatus) {
          const waitMs = Math.ceil((1 / throttleStatus.restoreRate) * 1000) * 2;
          logError(`  ${loteLabel}: throttle Shopify (disponible=${throttleStatus.currentlyAvailable}). Esperando ${waitMs}ms antes de reintentar (intento ${intentos}/${MAX_INTENTOS})`);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        logError(`  ${loteLabel}: error GraphQL: "${errMsg}" — SKUs omitidos en este lote`);
        break;
      }

      if (!json.data) {
        logError(`  ${loteLabel}: respuesta sin 'data' de Shopify — posible throttle silencioso. Esperando 2s (intento ${intentos}/${MAX_INTENTOS})`);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      edges = json.data.inventoryItems?.edges ?? [];
      break;
    }

    if (intentos === MAX_INTENTOS && edges.length === 0) {
      logError(`  ${loteLabel}: falló después de ${MAX_INTENTOS} intentos — lote omitido. SKUs: ${batch.join(", ")}`);
    }

    logInfo(`  ${loteLabel}: enviados ${batch.length} SKUs → Shopify devolvió ${edges.length} resultado(s)`);

    for (const { node } of edges) {
      const cantidad = siesaMap.get(node.sku);
      if (cantidad === undefined) {
        logInfo(`  SKU "${node.sku}" (id: ${node.id}): encontrado en Shopify pero NO en siesaMap (posible diferencia de formato)`);
        continue;
      }
      quantities.push({ inventoryItemId: node.id, locationId, quantity: cantidad });
    }
  }

  const encontrados = quantities.length;
  logInfo(`Encontrados en Shopify: ${encontrados} de ${items.length} — omitidos: ${items.length - encontrados}`);

  if (encontrados === 0) return 0;

  // Una sola mutation con todos los items encontrados en esta página
  const fecha = new Date().toISOString().slice(0, 10);
  const mutResp = await admin.graphql(MUTATION_SET_QUANTITIES, {
    variables: {
      input: {
        name: "available",
        reason: "correction",
        referenceDocumentUri: `app://appcyc/stocktake/${fecha}`,
        ignoreCompareQuantity: true,
        quantities,
      },
    },
  });

  const mutJson = (await mutResp.json()) as {
    data?: {
      inventorySetQuantities?: {
        userErrors: { field: string[]; message: string; code: string }[];
      };
    };
  };

  const userErrors = mutJson.data?.inventorySetQuantities?.userErrors ?? [];
  if (userErrors.length > 0) {
    for (const err of userErrors) {
      logError(`inventorySetQuantities error [${err.field?.join(".")}]: ${err.message}`);
    }
  } else {
    logInfo(`Inventario actualizado para ${encontrados} productos`);
  }

  return encontrados;
}

// ---------------------------------------------------------------------------
// Sincronización completa paginada
// ---------------------------------------------------------------------------
export async function ejecutarSyncCompleto(): Promise<{ totalItems: number; totalActualizados: number }> {
  let numPag = 1;
  let totalItems = 0;
  let totalActualizados = 0;

  logInfo("=== Inicio sincronización SIESA → Shopify ===");

  // Obtener cliente admin una sola vez (offline session de DB)
  const admin = await obtenerAdminClient();
  logInfo(`Sesión admin obtenida. Iniciando paginación SIESA.`);

  const MAX_PAGINAS = 500;

  while (numPag <= MAX_PAGINAS) {
    const url = buildSiesaUrl(numPag);
    logInfo(`Consultando página ${numPag}: ${url}`);

    let data: SiesaResponse;

    try {
      const response = await fetch(url, { headers: buildHeaders() });

      // HTTP 400 = SIESA indica que no hay más páginas, tratar como fin normal
      if (response.status === 400) {
        logInfo(`Página ${numPag}: SIESA respondió 400 (sin más resultados). Fin de paginación.`);
        break;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      data = (await response.json()) as SiesaResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`Error en página ${numPag}: ${msg}`);
      throw err;
    }

    // codigo === 1 también indica que no hay más páginas
    if (data!.codigo === 1) {
      logInfo(`Página ${numPag}: sin más resultados (codigo=1). Fin de paginación.`);
      break;
    }

    const items = data.detalle?.Table ?? [];
    logInfo(`Página ${numPag}: ${items.length} items recibidos`);

    const actualizadosPagina = await procesarItems(items, admin);
    totalItems += items.length;
    totalActualizados += actualizadosPagina;

    // Actualizar progreso en DB para que la UI pueda mostrarlo
    await prisma.syncEstado.upsert({
      where: { id: "singleton" },
      update: { paginaActual: numPag, totalItems, totalActualizados },
      create: { id: "singleton", estado: "en_progreso", paginaActual: numPag, totalItems, totalActualizados },
    });

    numPag++;
  }

  if (numPag > MAX_PAGINAS) {
    logError(`Se alcanzó el límite de ${MAX_PAGINAS} páginas. El sync puede estar incompleto.`);
  }

  logInfo(`=== Sincronización completada. SIESA: ${totalItems} | Shopify actualizados: ${totalActualizados} ===`);
  return { totalItems, totalActualizados };
}
