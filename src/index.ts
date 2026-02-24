#!/usr/bin/env node
/**
 * S60 Knowledge MCP Server
 * Strukturovaný přístup k dokumentaci, rozhodnutím a service info
 * pro Studio60 agenty po context compaction.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import {
  memoryStore,
  memoryUpdate,
  memoryDelete,
  semanticSearch,
  semanticSearchGlobal,
  type MemoryType,
  type MemoryScope,
} from "./qdrant.js";

// ─── Konfigurace cest ────────────────────────────────────────────────────────

const DOCS_DIR = "/root/dev/s60-docs";
const KNOWLEDGE_BASE = "/root/dev/KNOWLEDGE_BASE.md";
const SESSION_NOTES = "/root/dev/s60-docs/SESSION-NOTES.md";
const CLAUDE_MD = "/root/dev/CLAUDE.md";

// ─── Service info (hardcoded ze KNOWLEDGE_BASE.md) ──────────────────────────

const SERVICE_INFO: Record<string, object> = {
  auth: {
    name: "S60Auth",
    description: "Identity provider — OAuth2/OIDC, JWT tokeny, ForwardAuth",
    urls: {
      dev: "https://auth.s60dev.cz",
      staging: "https://auth.s60hub.cz",
      production: "https://auth.studio60.cz",
    },
    stack: "NestJS + PostgreSQL + Redis",
    repo: "/root/dev/s60-auth",
    docker: "infra-auth stack",
    notes: "ForwardAuth endpoint: /auth/forward — validuje tokeny pro Traefik",
  },
  badwolf: {
    name: "S60BadWolf",
    description: "Core NestJS backend — business logika, REST API",
    urls: {
      dev: "https://be.s60dev.cz/api",
      staging: "https://be.s60hub.cz/api",
      production: "https://be.studio60.cz/api",
    },
    stack: "NestJS + TypeORM + PostgreSQL",
    repo: "/root/dev/s60-badwolf",
    docker: "app-badwolf stack",
    modules: [
      "AuthModule (legacy verify)",
      "CoursesModule (Moodle proxy)",
      "OrdersModule (WC webhook)",
      "ClientsModule",
      "ApplicationsModule",
    ],
    notes: "BEZ autentizace zatím (single tenant dev). Spec: FOR_BADWOLF_AGENT.md",
  },
  venom: {
    name: "S60Venom",
    description: "Admin CRM — React frontend pro správu přihlášek",
    urls: {
      dev: "https://venom.s60dev.cz",
      staging: "https://venom.s60hub.cz",
    },
    stack: "React + TypeScript + Vite + shadcn/ui + TailwindCSS",
    repo: "/root/dev/s60-venom",
    docker: "app-venom stack",
    notes: "State-based routing (Layout.tsx). Backend: be.s60dev.cz/api",
  },
  redis: {
    name: "Redis",
    description: "Cache + message queue (BullMQ) + token/session store",
    urls: {
      dev: "redis://localhost:6379",
    },
    docker: "infra-redis stack",
    uses: ["Token cache (S60Auth ForwardAuth)", "BullMQ fronty (core→edge events)", "Moodle data cache"],
    notes: "AOF persistence, named volume",
  },
  postgres: {
    name: "PostgreSQL (DO Managed)",
    description: "Hlavní databáze pro S60Auth, S60BadWolf, Billit",
    host: "s60-postgres-dev-do-user-28025597-0.f.db.ondigitalocean.com",
    port: 25060,
    database: "s60_badwolf",
    user: "doadmin",
    password_ref: "KNOWLEDGE_BASE.md → PostgreSQL sekce",
    stats: {
      applications: 6868,
      clients: 20870,
      course_dates: 347,
    },
    schema: "/root/dev/s60-badwolf/scripts/migrate-jenkins/schema.sql",
    notes: "SSL required. Credentials v /root/dev/s60-infra/.env (MANAGED_PG_*)",
  },
  traefik: {
    name: "Traefik",
    description: "Reverse proxy, SSL termination, ForwardAuth middleware",
    urls: {
      dev: "http://localhost:8080 (dashboard)",
    },
    docker: "infra-proxy stack",
    config: "/root/dev/s60-infra/infra-proxy/routes.yml",
    notes: "Auto-reload při změně routes.yml. DNS: 8.8.8.8 / 1.1.1.1 (pro ACME)",
  },
  n8n: {
    name: "n8n",
    description: "Automatizace workflow — queue mode + Redis",
    urls: {
      dev: "https://n8n.s60dev.cz",
    },
    stack: "n8n + PostgreSQL (vlastní) + Redis",
    docker: "infra-n8n stack",
    notes: "Kritické: N8N_ENCRYPTION_KEY zálohovat!",
  },
  fess: {
    name: "FESS (Static File Server)",
    description: "Static file server pro upload dashboard content",
    urls: {
      dev: "https://fess.s60dev.cz",
    },
    sftp: {
      host: "fess.s60dev.cz",
      port: 22,
      user: "fess",
      path: "/www",
    },
    notes: "Setup docs: /root/dev/s60-infra/FESS_SETUP.md",
  },
};

// ─── Pomocné funkce ──────────────────────────────────────────────────────────

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function getAllMdFiles(): string[] {
  const files: string[] = [];

  // KNOWLEDGE_BASE.md
  if (fs.existsSync(KNOWLEDGE_BASE)) files.push(KNOWLEDGE_BASE);
  if (fs.existsSync(CLAUDE_MD)) files.push(CLAUDE_MD);

  // Všechny .md soubory v s60-docs/
  if (fs.existsSync(DOCS_DIR)) {
    const walkDir = (dir: string) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walkDir(fullPath);
          } else if (entry.isFile() && entry.name.endsWith(".md")) {
            files.push(fullPath);
          }
        }
      } catch {
        // skip unreadable dirs
      }
    };
    walkDir(DOCS_DIR);
  }

  return files;
}

interface SearchMatch {
  file: string;
  lineNumber: number;
  line: string;
  context: string[];
}

function searchInFiles(query: string, maxResults = 30): SearchMatch[] {
  const files = getAllMdFiles();
  const results: SearchMatch[] = [];
  const queryLower = query.toLowerCase();

  for (const filePath of files) {
    const content = readFileSafe(filePath);
    if (!content) continue;

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(queryLower)) {
        const contextStart = Math.max(0, i - 2);
        const contextEnd = Math.min(lines.length - 1, i + 2);
        const context = lines.slice(contextStart, contextEnd + 1);

        results.push({
          file: filePath.replace("/root/dev/", ""),
          lineNumber: i + 1,
          line: lines[i],
          context,
        });

        if (results.length >= maxResults) break;
      }
    }
    if (results.length >= maxResults) break;
  }

  return results;
}

function getLastLines(filePath: string, lines: number): string {
  const content = readFileSafe(filePath);
  if (!content) return `Soubor nenalezen: ${filePath}`;

  const allLines = content.split("\n");
  const lastN = allLines.slice(-lines);
  return lastN.join("\n");
}

function appendToSessionNotes(text: string): void {
  const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  const time = new Date().toISOString().split("T")[1].substring(0, 5); // HH:MM
  const entry = `\n## ${date} - ${time} - ${text}\n`;

  fs.appendFileSync(SESSION_NOTES, entry, "utf-8");
}

function getDocsListing(): Array<{ path: string; size: number; name: string }> {
  const files = getAllMdFiles();
  return files.map((filePath) => {
    try {
      const stat = fs.statSync(filePath);
      return {
        path: filePath.replace("/root/dev/", ""),
        name: path.basename(filePath),
        size: stat.size,
      };
    } catch {
      return { path: filePath.replace("/root/dev/", ""), name: path.basename(filePath), size: 0 };
    }
  });
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new Server(
  {
    name: "s60-knowledge",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ─── List Tools ──────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search_docs",
        description:
          "Fulltext search přes všechny .md soubory v s60-docs/ + KNOWLEDGE_BASE.md + CLAUDE.md. " +
          "Vrátí matching řádky s kontextem (±2 řádky). " +
          "Použití: 'JWT', 'S60Auth logout', 'ForwardAuth', 'aplikace status enum'",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Hledaný výraz (case-insensitive)",
            },
            max_results: {
              type: "number",
              description: "Max počet výsledků (default: 20)",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "get_session_notes",
        description:
          "Vrátí posledních N řádků ze SESSION-NOTES.md. " +
          "Nejrychlejší způsob jak zjistit poslední rozhodnutí po context compaction. " +
          "Default: 150 řádků",
        inputSchema: {
          type: "object",
          properties: {
            lines: {
              type: "number",
              description: "Počet řádků od konce (default: 150)",
            },
          },
          required: [],
        },
      },
      {
        name: "log_decision",
        description:
          "Zapíše timestampovaný záznam do SESSION-NOTES.md. " +
          "Agenti MUSÍ zapisovat důležitá rozhodnutí aby přežila context compaction. " +
          "Format: '## [datum] [čas] - <text>'",
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "Text rozhodnutí / záznamu. Může obsahovat markdown, víceřádkový text.",
            },
          },
          required: ["text"],
        },
      },
      {
        name: "get_service_info",
        description:
          "Vrátí strukturovaný přehled S60 služby — URL, stack, repo, porty, docker stack, notes. " +
          "Dostupné služby: auth, badwolf, venom, redis, postgres, traefik, n8n, fess, all",
        inputSchema: {
          type: "object",
          properties: {
            service: {
              type: "string",
              description:
                "Název služby: auth | badwolf | venom | redis | postgres | traefik | n8n | fess | all",
            },
          },
          required: [],
        },
      },
      {
        name: "list_docs",
        description:
          "Vrátí seznam všech .md souborů v s60-docs/ + KNOWLEDGE_BASE.md. " +
          "Pomáhá orientaci co existuje, s velikostí souboru.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "memory_store",
        description:
          "Uloží text do sémantické paměti (Qdrant). " +
          "scope='global' → sdíleno napříč všemi agenty. " +
          "Ostatní scopy (s60, bw, fess, billit, sentinel...) → per-workspace. " +
          "Každý agent MUSÍ ukládat rozhodnutí, kontext a důležité informace sem.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text k uložení" },
            scope: {
              type: "string",
              description: "Scope: global | s60 | bw | sentinel | billit | shopagent | fess | <vlastní>",
            },
            agent: { type: "string", description: "Identifikátor agenta (main, venom, badwolf, fess...)" },
            type: {
              type: "string",
              description: "Typ: decision | context | api | error | doc | note | memory | person | event",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Volitelné tagy pro filtrování",
            },
          },
          required: ["text", "scope", "agent", "type"],
        },
      },
      {
        name: "semantic_search",
        description:
          "Sémantické vyhledávání v paměti — hledá podle významu, ne přesného textu. " +
          "Vždy prohledá memory-global + daný scope. " +
          "Ideální pro: 'co víme o X?', 'jak jsme to řešili?', 'najdi rozhodnutí o Y'.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Dotaz v přirozeném jazyce" },
            scope: {
              type: "string",
              description: "Scope workspace (volitelné): s60 | bw | sentinel | billit | fess | ...",
            },
            type: {
              type: "string",
              description: "Filtr typu (volitelné): decision | context | api | error | doc | note | memory | person | event",
            },
            limit: { type: "number", description: "Max výsledků (default: 10)" },
          },
          required: ["query"],
        },
      },
      {
        name: "memory_search_global",
        description:
          "Prohledá pouze memory-global — cross-projekt znalosti sdílené všemi agenty. " +
          "Rychlejší než semantic_search když hledáš obecné konvence nebo architekturu.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Dotaz v přirozeném jazyce" },
            limit: { type: "number", description: "Max výsledků (default: 10)" },
          },
          required: ["query"],
        },
      },
      {
        name: "memory_update",
        description: "Aktualizuje existující záznam v Qdrantu (přepíše text + přepočítá vektor).",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "UUID záznamu (vráceno z memory_store)" },
            text: { type: "string", description: "Nový text" },
            collection: {
              type: "string",
              description: "Kolekce: global | workspace (default: workspace)",
            },
          },
          required: ["id", "text"],
        },
      },
      {
        name: "memory_delete",
        description: "Smaže záznam z Qdrantu.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "UUID záznamu" },
            collection: { type: "string", description: "global | workspace (default: workspace)" },
          },
          required: ["id"],
        },
      },
    ],
  };
});

// ─── Call Tool ───────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "search_docs") {
    const query = String(args?.query ?? "");
    const maxResults = Number(args?.max_results ?? 20);

    if (!query.trim()) {
      return {
        content: [{ type: "text", text: "Chybí query parametr." }],
      };
    }

    const matches = searchInFiles(query, maxResults);

    if (matches.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `Žádné výsledky pro: "${query}"\n\nZkus jiný výraz nebo použij list_docs() pro přehled souborů.`,
          },
        ],
      };
    }

    // Seskup výsledky podle souboru
    const byFile = new Map<string, SearchMatch[]>();
    for (const match of matches) {
      const existing = byFile.get(match.file) ?? [];
      existing.push(match);
      byFile.set(match.file, existing);
    }

    let output = `Nalezeno ${matches.length} výsledků pro "${query}":\n\n`;

    for (const [file, fileMatches] of byFile.entries()) {
      output += `### 📄 ${file}\n`;
      for (const match of fileMatches) {
        output += `\n**Řádek ${match.lineNumber}:**\n`;
        output += "```\n";
        output += match.context.join("\n");
        output += "\n```\n";
      }
      output += "\n";
    }

    return { content: [{ type: "text", text: output }] };
  }

  if (name === "get_session_notes") {
    const lines = Number(args?.lines ?? 150);
    const content = getLastLines(SESSION_NOTES, lines);

    return {
      content: [
        {
          type: "text",
          text: `### SESSION-NOTES.md — posledních ${lines} řádků:\n\n${content}`,
        },
      ],
    };
  }

  if (name === "log_decision") {
    const text = String(args?.text ?? "");

    if (!text.trim()) {
      return {
        content: [{ type: "text", text: "Chybí text parametr." }],
      };
    }

    try {
      appendToSessionNotes(text);
      const date = new Date().toISOString().split("T")[0];
      const time = new Date().toISOString().split("T")[1].substring(0, 5);
      return {
        content: [
          {
            type: "text",
            text: `✅ Zapsáno do SESSION-NOTES.md:\n## ${date} - ${time} - ${text}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `❌ Chyba při zápisu: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  }

  if (name === "get_service_info") {
    const service = String(args?.service ?? "all").toLowerCase();

    if (service === "all") {
      const allInfo = Object.entries(SERVICE_INFO).map(([key, info]) => {
        return `### ${key.toUpperCase()}\n\`\`\`json\n${JSON.stringify(info, null, 2)}\n\`\`\``;
      });
      return {
        content: [
          {
            type: "text",
            text: `# S60 Service Info — všechny služby\n\n${allInfo.join("\n\n")}`,
          },
        ],
      };
    }

    const info = SERVICE_INFO[service];
    if (!info) {
      const available = Object.keys(SERVICE_INFO).join(", ");
      return {
        content: [
          {
            type: "text",
            text: `Neznámá služba: "${service}"\n\nDostupné: ${available}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `### S60 Service: ${service.toUpperCase()}\n\`\`\`json\n${JSON.stringify(info, null, 2)}\n\`\`\``,
        },
      ],
    };
  }

  if (name === "memory_store") {
    try {
      const id = await memoryStore({
        text: String(args?.text ?? ""),
        scope: String(args?.scope ?? "s60") as MemoryScope,
        agent: String(args?.agent ?? "unknown"),
        type: String(args?.type ?? "note") as MemoryType,
        tags: Array.isArray(args?.tags) ? args.tags as string[] : [],
      });
      return { content: [{ type: "text", text: `✅ Uloženo do Qdrantu\nID: ${id}\nScope: ${args?.scope}, Type: ${args?.type}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Chyba: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }

  if (name === "semantic_search") {
    try {
      const results = await semanticSearch({
        query: String(args?.query ?? ""),
        scope: args?.scope ? String(args.scope) as MemoryScope : undefined,
        type: args?.type ? String(args.type) as MemoryType : undefined,
        limit: args?.limit ? Number(args.limit) : 10,
      });

      if (results.length === 0) {
        return { content: [{ type: "text", text: `Žádné výsledky pro: "${args?.query}"` }] };
      }

      let out = `### Sémantické vyhledávání: "${args?.query}"\n${results.length} výsledků:\n\n`;
      for (const r of results) {
        out += `**[${(r.score * 100).toFixed(0)}%]** scope:${r.payload.scope} type:${r.payload.type} agent:${r.payload.agent}\n`;
        out += `> ${r.payload.text}\n`;
        if (r.payload.tags?.length) out += `_tags: ${r.payload.tags.join(", ")}_\n`;
        out += `id: \`${r.id}\` | ${r.payload.created_at}\n\n`;
      }
      return { content: [{ type: "text", text: out }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Chyba: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }

  if (name === "memory_search_global") {
    try {
      const results = await semanticSearchGlobal({
        query: String(args?.query ?? ""),
        limit: args?.limit ? Number(args.limit) : 10,
      });

      if (results.length === 0) {
        return { content: [{ type: "text", text: `Žádné globální záznamy pro: "${args?.query}"` }] };
      }

      let out = `### Global memory: "${args?.query}"\n${results.length} výsledků:\n\n`;
      for (const r of results) {
        out += `**[${(r.score * 100).toFixed(0)}%]** type:${r.payload.type} agent:${r.payload.agent}\n`;
        out += `> ${r.payload.text}\n`;
        out += `id: \`${r.id}\` | ${r.payload.created_at}\n\n`;
      }
      return { content: [{ type: "text", text: out }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Chyba: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }

  if (name === "memory_update") {
    try {
      await memoryUpdate({
        id: String(args?.id ?? ""),
        text: String(args?.text ?? ""),
        collection: args?.collection === "global" ? "global" : "workspace",
      });
      return { content: [{ type: "text", text: `✅ Záznam ${args?.id} aktualizován` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Chyba: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }

  if (name === "memory_delete") {
    try {
      await memoryDelete({
        id: String(args?.id ?? ""),
        collection: args?.collection === "global" ? "global" : "workspace",
      });
      return { content: [{ type: "text", text: `✅ Záznam ${args?.id} smazán` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Chyba: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }

  if (name === "list_docs") {
    const docs = getDocsListing();

    let output = `### S60 Dokumentace — ${docs.length} .md souborů\n\n`;
    output += "| Soubor | Cesta | Velikost |\n";
    output += "|--------|-------|----------|\n";

    for (const doc of docs.sort((a, b) => a.path.localeCompare(b.path))) {
      const sizeKb = (doc.size / 1024).toFixed(1);
      output += `| ${doc.name} | ${doc.path} | ${sizeKb} KB |\n`;
    }

    return { content: [{ type: "text", text: output }] };
  }

  return {
    content: [{ type: "text", text: `Neznámý tool: ${name}` }],
    isError: true,
  };
});

// ─── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
