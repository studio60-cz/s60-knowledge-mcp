/**
 * Qdrant + FastEmbed — sémantická paměť pro S60 agenty
 *
 * Kolekce:
 *   memory-global    — sdíleno napříč všemi agenty
 *   memory-workspace — per-scope (s60, bw, fess, billit, sentinel...)
 *
 * Embedding: BAAI/bge-base-en-v1.5 (768 dims, lokální ONNX, bez API)
 */

import { QdrantClient } from "@qdrant/js-client-rest";
import { EmbeddingModel, FlagEmbedding } from "fastembed";

// ─── Config ──────────────────────────────────────────────────────────────────

const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY ?? "9354f848b7a98269c1cd1a9d822cd1167c05e17260f0b7eb26b60e1d83281a7d";

const COLLECTION_GLOBAL = "memory-global";
const COLLECTION_WORKSPACE = "memory-workspace";
const VECTOR_SIZE = 768;

// ─── Singleton klienti ────────────────────────────────────────────────────────

let qdrant: QdrantClient | null = null;
let embedder: FlagEmbedding | null = null;

function getQdrant(): QdrantClient {
  if (!qdrant) {
    qdrant = new QdrantClient({ url: QDRANT_URL, apiKey: QDRANT_API_KEY });
  }
  return qdrant;
}

async function getEmbedder(): Promise<FlagEmbedding> {
  if (!embedder) {
    embedder = await FlagEmbedding.init({
      model: EmbeddingModel.BGEBaseEN,
      cacheDir: "/root/.cache/fastembed",
    });
  }
  return embedder;
}

// ─── Typy ─────────────────────────────────────────────────────────────────────

export type MemoryScope = "global" | "s60" | "bw" | "sentinel" | "billit" | "shopagent" | "fess" | string;
export type MemoryType = "decision" | "context" | "api" | "error" | "doc" | "note" | "memory" | "person" | "event";

export interface MemoryPayload {
  scope: MemoryScope;
  agent: string;
  type: MemoryType;
  tags: string[];
  text: string;
  created_at: string;
  updated_at?: string;
}

export interface MemoryResult {
  id: string;
  score: number;
  payload: MemoryPayload;
}

// ─── Embedding ────────────────────────────────────────────────────────────────

async function embed(text: string): Promise<number[]> {
  const emb = await getEmbedder();
  const results = emb.queryEmbed(text);
  for await (const vector of results) {
    return Array.from(vector);
  }
  throw new Error("Embedding failed — no output");
}

// ─── Kolekce: zajisti existenci ───────────────────────────────────────────────

async function ensureCollections(): Promise<void> {
  const client = getQdrant();
  const { collections } = await client.getCollections();
  const names = new Set(collections.map((c) => c.name));

  for (const name of [COLLECTION_GLOBAL, COLLECTION_WORKSPACE]) {
    if (!names.has(name)) {
      await client.createCollection(name, {
        vectors: { size: VECTOR_SIZE, distance: "Cosine" },
      });
      for (const field of ["scope", "agent", "type"]) {
        await client.createPayloadIndex(name, {
          field_name: field,
          field_schema: "keyword",
        });
      }
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Uloží text do Qdrantu.
 * scope="global" → memory-global
 * jiný scope     → memory-workspace (filtr scope)
 */
export async function memoryStore(params: {
  text: string;
  scope: MemoryScope;
  agent: string;
  type: MemoryType;
  tags?: string[];
}): Promise<string> {
  await ensureCollections();
  const client = getQdrant();
  const vector = await embed(params.text);
  const id = crypto.randomUUID();

  const payload: MemoryPayload = {
    scope: params.scope,
    agent: params.agent,
    type: params.type,
    tags: params.tags ?? [],
    text: params.text,
    created_at: new Date().toISOString(),
  };

  const collection = params.scope === "global" ? COLLECTION_GLOBAL : COLLECTION_WORKSPACE;

  await client.upsert(collection, {
    wait: true,
    points: [{ id, vector, payload }],
  });

  return id;
}

/**
 * Sémantické vyhledávání — prohledá global + daný scope.
 */
export async function semanticSearch(params: {
  query: string;
  scope?: MemoryScope;
  type?: MemoryType;
  limit?: number;
}): Promise<MemoryResult[]> {
  await ensureCollections();
  const client = getQdrant();
  const vector = await embed(params.query);
  const limit = params.limit ?? 10;
  const results: MemoryResult[] = [];

  // Vždy prohledej global
  const globalHits = await client.search(COLLECTION_GLOBAL, {
    vector,
    limit,
    with_payload: true,
    score_threshold: 0.5,
  });

  for (const hit of globalHits) {
    results.push({
      id: String(hit.id),
      score: hit.score,
      payload: hit.payload as MemoryPayload,
    });
  }

  // Prohledej workspace se scope filtrem
  if (params.scope && params.scope !== "global") {
    const filter: Record<string, unknown> = {
      must: [{ key: "scope", match: { value: params.scope } }],
    };
    if (params.type) {
      (filter.must as unknown[]).push({ key: "type", match: { value: params.type } });
    }

    const workspaceHits = await client.search(COLLECTION_WORKSPACE, {
      vector,
      limit,
      with_payload: true,
      score_threshold: 0.5,
      filter,
    });

    for (const hit of workspaceHits) {
      results.push({
        id: String(hit.id),
        score: hit.score,
        payload: hit.payload as MemoryPayload,
      });
    }
  }

  // Seřaď podle skóre, odstraň duplikáty
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Vyhledá pouze v memory-global.
 */
export async function semanticSearchGlobal(params: {
  query: string;
  limit?: number;
}): Promise<MemoryResult[]> {
  await ensureCollections();
  const client = getQdrant();
  const vector = await embed(params.query);

  const hits = await client.search(COLLECTION_GLOBAL, {
    vector,
    limit: params.limit ?? 10,
    with_payload: true,
    score_threshold: 0.4,
  });

  return hits.map((hit) => ({
    id: String(hit.id),
    score: hit.score,
    payload: hit.payload as MemoryPayload,
  }));
}

/**
 * Aktualizuje existující záznam (přepíše text + vektor).
 */
export async function memoryUpdate(params: {
  id: string;
  text: string;
  collection?: "global" | "workspace";
}): Promise<void> {
  await ensureCollections();
  const client = getQdrant();
  const vector = await embed(params.text);
  const collection = params.collection === "global" ? COLLECTION_GLOBAL : COLLECTION_WORKSPACE;

  await client.setPayload(collection, {
    payload: { text: params.text, updated_at: new Date().toISOString() },
    points: [params.id],
    wait: true,
  });

  await client.updateVectors(collection, {
    points: [{ id: params.id, vector }],
    wait: true,
  });
}

/**
 * Smaže záznam.
 */
export async function memoryDelete(params: {
  id: string;
  collection?: "global" | "workspace";
}): Promise<void> {
  const client = getQdrant();
  const collection = params.collection === "global" ? COLLECTION_GLOBAL : COLLECTION_WORKSPACE;
  await client.delete(collection, { wait: true, points: [params.id] });
}
