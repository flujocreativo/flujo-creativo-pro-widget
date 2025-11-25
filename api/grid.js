// api/grid.js
import { Client } from "@notionhq/client";

// 1) LEER VARIABLES con fallback de nombres
const NOTION_TOKEN =
  process.env.NOTION_TOKEN ||
  process.env.NOTION_API_TOKEN ||
  process.env.NOTION_SECRET;

const NOTION_DB_ID =
  process.env.NOTION_DB_ID ||
  process.env.NOTION_DATABASE_ID || // <-- el que tú tienes en Vercel
  process.env.NOTION_DB ||
  process.env.NOTION_CONTENT_DB_ID;

function error(res, msg, status = 500) {
  res.status(status).json({ ok: false, error: msg });
}

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

function readMultiSelect(prop) {
  if (!Array.isArray(prop?.multi_select)) return [];
  return prop.multi_select.map((s) => s.name);
}

function readRichTextUrl(prop) {
  // lectura de propiedades tipo texto que contienen un link
  if (!prop) return null;
  if (Array.isArray(prop.rich_text) && prop.rich_text.length) {
    const val = prop.rich_text.map((t) => t.plain_text).join("").trim();
    return val || null;
  }
  if (Array.isArray(prop.title) && prop.title.length) {
    const val = prop.title.map((t) => t.plain_text).join("").trim();
    return val || null;
  }
  if (typeof prop === "string") {
    const val = prop.trim();
    return val || null;
  }
  return null;
}

function readUrl(prop) {
  // propiedad tipo URL de Notion
  return prop?.url || null;
}

function readPeople(prop) {
  if (!Array.isArray(prop?.people)) return null;
  if (!prop.people.length) return null;
  // solo 1 dueño principal (el primero)
  return prop.people[0]?.name || null;
}

function readRelationName(prop) {
  // fallback si no hay rollup
  if (!prop) return null;
  if (Array.isArray(prop.relation) && prop.relation.length) {
    // devolvemos solo “(relation)” porque sin otra query no tenemos el nombre
    return "(relation)";
  }
  return null;
}

function readRollupName(prop) {
  if (!prop?.rollup) return null;
  const r = prop.rollup;
  if (r.type === "array") {
    const arr = r.array;
    if (!Array.isArray(arr) || !arr.length) return null;
    // intentamos texto del primer item
    const first = arr[0];
    if (first.type === "title") {
      return first.title?.[0]?.plain_text || null;
    }
    if (first.type === "rich_text") {
      return first.rich_text?.[0]?.plain_text || null;
    }
    return null;
  }
  if (r.type === "number") return String(r.number);
  return null;
}

function guessAssetType(url) {
  if (!url) return "image";
  const lower = String(url).toLowerCase();

  // video
  if (lower.match(/\.(mp4|mov|webm)(\?|$)/) || lower.includes("video")) return "video";

  // image
  if (lower.match(/\.(png|jpe?g|gif|webp)(\?|$)/) || lower.includes("image")) return "image";

  return "unknown";
}

function getTextUrl(prop) {
  if (!prop) return null;
  if (prop.url) return String(prop.url).trim() || null; // Notion URL-type
  if (Array.isArray(prop.rich_text) && prop.rich_text.length) {
    return prop.rich_text.map(t => t.plain_text).join("").trim() || null;
  }
  if (Array.isArray(prop.title) && prop.title.length) {
    return prop.title.map(t => t.plain_text).join("").trim() || null;
  }
  if (typeof prop === "string") return prop.trim() || null;
  return null;
}

function pushTextAsset(assets, url, source) {
  if (!url) return;
  assets.push({
    url,
    type: guessAssetType(url),
    source,
  });
}

function extractAssets(props) {
  // prioridad 1: Attachment (files)
  if (props.Attachment?.files?.length) {
    return props.Attachment.files.map((f) => ({
      url: f.file?.url || f.external?.url,
      type: guessAssetType(f.file?.url || f.external?.url),
      source: "attachment",
    }));
  }

  // prioridad 2: Link (URL prop o texto)
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

  // prioridad 3: Canva (URL prop o texto)
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

function normalizePost(page) {
  const props = page.properties || {};

  const title = readTitle(props.Name) || "Untitled";
  const publishDate = readDate(props["Publish Date"]);
  const hide = readCheckbox(props.Hide);

  const brand = readSelect(props.Brand);
  const project =
    readRollupName(props.ProjectName) ||
    readSelect(props.Project) ||
    readRelationName(props.Project);

  const client =
    readRollupName(props.ClientName) ||
    readSelect(props.Client) ||
    readRelationName(props.Client);

  const platform = readSelect(props.Platform);
  const status = readSelect(props.Status) || "Draft";
  const owner = readPeople(props.Owner);

  const assets = extractAssets(props);

  return {
    id: page.id,
    title,
    publishDate,
    hide,
    brand,
    client,
    project,
    platform,
    status,
    owner,
    assets,
    createdTime: page.created_time,
    url: page.url,
  };
}

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

  // asignar colores determinísticos
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

export default async function handler(req, res) {
  if (!NOTION_TOKEN || !NOTION_DB_ID) {
    return error(
      res,
      "Missing NOTION_TOKEN or NOTION_DATABASE_ID env vars.",
      400
    );
  }

  const notion = new Client({ auth: NOTION_TOKEN });

  try {
    const resp = await notion.databases.query({
      database_id: NOTION_DB_ID,
      page_size: 100,
      filter: {
        and: [
          // Hide = false (lo único obligatorio)
          {
            property: "Hide",
            checkbox: { equals: false },
          },
        ],
      },
      sorts: [
        {
          property: "Publish Date",
          direction: "descending",
        },
        {
          timestamp: "created_time",
          direction: "descending",
        },
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
