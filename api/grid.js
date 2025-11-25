// api/grid.js
import { Client } from "@notionhq/client";

// -------------------------------
//  ENV VARS
// -------------------------------
const NOTION_TOKEN =
  process.env.NOTION_TOKEN ||
  process.env.NOTION_API_TOKEN ||
  process.env.NOTION_SECRET;

const NOTION_DB_ID =
  process.env.NOTION_DATABASE_ID || // ESTE es el que usas en Vercel
  process.env.NOTION_DB_ID ||
  process.env.NOTION_DB ||
  process.env.NOTION_CONTENT_DB_ID;

function error(res, msg, status = 500) {
  res.status(status).json({ ok: false, error: msg });
}

// -------------------------------
//  HELPERS
// -------------------------------
function readTitle(prop) {
  if (!prop) return "";
  if (Array.isArray(prop.title) && prop.title.length) {
    return prop.title.map((t) => t.plain_text).join("");
  }
  if (Array.isArray(prop.rich_text) && prop.rich_text.length) {
    return prop.rich_text.map((t) => t.plain_text).join("");
  }
  return "";
}

function readDate(prop) {
  if (!prop?.date?.start) return null;
  return prop.date.start;
}

function readCheckbox(prop) {
  return !!prop?.checkbox;
}

function readSelect(prop) {
  return prop?.select?.name || null;
}

function readPeople(prop) {
  if (!Array.isArray(prop?.people)) return null;
  if (!prop.people.length) return null;
  return prop.people[0]?.name || null;
}

function readRollupName(prop) {
  if (!prop?.rollup) return null;
  const r = prop.rollup;

  if (r.type === "array") {
    const arr = r.array;
    if (!Array.isArray(arr) || !arr.length) return null;

    const first = arr[0];
    if (first.type === "title") {
      return first.title?.[0]?.plain_text || null;
    }
    if (first.type === "rich_text") {
      return first.rich_text?.[0]?.plain_text || null;
    }
  }

  if (r.type === "number") return String(r.number);
  return null;
}

function guessAssetType(url) {
  if (!url) return "image";
  const lower = String(url).toLowerCase();

  if (lower.match(/\.(mp4|mov|webm)(\?|$)/) || lower.includes("video"))
    return "video";
  if (lower.match(/\.(png|jpe?g|gif|webp)(\?|$)/) || lower.includes("image"))
    return "image";

  return "unknown";
}

function getTextUrl(prop) {
  if (!prop) return null;

  if (prop.url) return prop.url.trim();

  if (Array.isArray(prop.rich_text) && prop.rich_text.length) {
    return prop.rich_text.map((t) => t.plain_text).join("").trim() || null;
  }

  if (Array.isArray(prop.title) && prop.title.length) {
    return prop.title.map((t) => t.plain_text).join("").trim() || null;
  }

  if (typeof prop === "string") return prop.trim() || null;

  return null;
}

function extractAssets(props) {
  // 1) Files (Attachment)
  if (props.Attachment?.files?.length) {
    return props.Attachment.files.map((f) => ({
      url: f.file?.url || f.external?.url,
      type: guessAssetType(f.file?.url || f.external?.url),
      source: "attachment",
    }));
  }

  // 2) Link
  const linkUrl = getTextUrl(props.Link);
  if (linkUrl) {
    return [
      {
        url: linkUrl,
        type: guessAssetType(linkUrl),
        source: "link",
      },
    ];
  }

  // 3) Canva
  const canvaUrl = getTextUrl(props.Canva);
  if (canvaUrl) {
    return [
      {
        url: canvaUrl,
        type: guessAssetType(canvaUrl),
        source: "canva",
      },
    ];
  }

  return [];
}

// -------------------------------
//  NORMALIZE EACH POST
// -------------------------------
function normalizePost(page) {
  const props = page.properties || {};

  return {
    id: page.id,
    title: readTitle(props.Name) || "Untitled",
    publishDate: readDate(props["Publish Date"]),
    hide: readCheckbox(props.Hide),

    brand: readSelect(props.Brand),

    project:
      readRollupName(props.ProjectName) ||
      readSelect(props.Project) ||
      null,

    client:
      readRollupName(props.ClientName) ||
      readSelect(props.Client) ||
      null,

    platform: readSelect(props.Platform),
    status: readSelect(props.Status) || "Draft",
    owner: readPeople(props.Owner),

    assets: extractAssets(props),
    createdTime: page.created_time,
    url: page.url,
  };
}

// -------------------------------
//  FILTER BUILDER
// -------------------------------
function buildFiltersFromPosts(posts) {
  const clients = new Set();
  const projects = new Set();
  const brands = new Set();
  const owners = new Map();

  posts.forEach((p) => {
    if (p.client) clients.add(p.client);
    if (p.project) projects.add(p.project);
    if (p.brand) brands.add(p.brand);
    if (p.owner) {
      if (!owners.has(p.owner)) owners.set(p.owner, 0);
      owners.set(p.owner, owners.get(p.owner) + 1);
    }
  });

  const OWNER_COLORS = [
    "#E7E3D5",
    "#DAD1C2",
    "#CBB9A4",
    "#B8A18B",
    "#A58A73",
    "#8B6D58",
  ];

  const ownerArr = Array.from(owners.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name], i) => ({
      name,
      color: OWNER_COLORS[i % OWNER_COLORS.length],
    }));

  return {
    clients: Array.from(clients).sort(),
    projects: Array.from(projects).sort(),
    brands: Array.from(brands).sort(),
    platforms: [
      "Instagram",
      "Tiktok",
      "Youtube",
      "Facebook",
      "Página web",
      "Pantalla",
    ],
    owners: ownerArr,
  };
}

// -------------------------------
//  MAIN HANDLER
// -------------------------------
export default async function handler(req, res) {
  if (!NOTION_TOKEN || !NOTION_DB_ID) {
    return error(res, "Missing NOTION_TOKEN or NOTION_DATABASE_ID env vars.", 400);
  }

  const notion = new Client({ auth: NOTION_TOKEN });

  try {
    // ---- Intentar query sin depender de Hide ----
    let dbFilter = undefined;

    // Si el user tiene columna Hide => filtrar correctamente
    try {
      const dbInfo = await notion.databases.retrieve({
        database_id: NOTION_DB_ID,
      });

      const hasHide = !!dbInfo.properties?.Hide;
      if (hasHide) {
        dbFilter = {
          and: [
            {
              property: "Hide",
              checkbox: { equals: false },
            },
          ],
        };
      }
    } catch (err) {
      // si falla retrieve, seguimos sin filter
    }

    const resp = await notion.databases.query({
      database_id: NOTION_DB_ID,
      page_size: 100,
      ...(dbFilter ? { filter: dbFilter } : {}),
      sorts: [
        { property: "Publish Date", direction: "descending" },
        { timestamp: "created_time", direction: "descending" },
      ],
    });

    const items = (resp.results || []).map(normalizePost);
    const filters = buildFiltersFromPosts(items);

    res.status(200).json({
      ok: true,
      dbId: NOTION_DB_ID,
      items,
      filters,
      hasMore: resp.has_more,
      nextCursor: resp.next_cursor,
    });
  } catch (e) {
    console.error(e);
    error(res, e.message || "Notion query failed");
  }
}
