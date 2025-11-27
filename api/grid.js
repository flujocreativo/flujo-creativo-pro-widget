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
  process.env.NOTION_DATABASE_ID ||
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
  if (Array.isArray(prop.title)) {
    return prop.title.map(t => t.plain_text).join("");
  }
  if (Array.isArray(prop.rich_text)) {
    return prop.rich_text.map(t => t.plain_text).join("");
  }
  return "";
}

function readDate(prop) {
  return prop?.date?.start || null;
}

function readCheckbox(prop) {
  return !!prop?.checkbox;
}

function readSelect(prop) {
  return prop?.select?.name || null;
}

function readRichText(prop) {
  if (!prop) return "";
  if (Array.isArray(prop.rich_text)) {
    return prop.rich_text.map(t => t.plain_text).join("").trim();
  }
  return "";
}

// ✅ FIX: solo detecta video por extensión real (.mp4 / .mov)
function guessAssetType(url) {
  if (!url) return "image";
  const clean = url.split("?")[0].toLowerCase();

  if (clean.endsWith(".mp4") || clean.endsWith(".mov")) {
    return "video";
  }

  return "image";
}

function readTextUrl(prop) {
  if (!prop) return null;

  if (prop.url) return prop.url.trim();

  if (Array.isArray(prop.rich_text)) {
    return prop.rich_text.map(t => t.plain_text).join("").trim() || null;
  }

  if (Array.isArray(prop.title)) {
    return prop.title.map(t => t.plain_text).join("").trim() || null;
  }

  if (typeof prop === "string") return prop.trim();

  return null;
}

// -------------------------------
//  ASSETS
// -------------------------------
function extractAssets(props) {
  // 1. Attachment (files)
  if (props.Attachment?.files?.length) {
    return props.Attachment.files.map(f => ({
      url: f.file?.url || f.external?.url,
      type: guessAssetType(f.file?.url || f.external?.url),
      source: "attachment",
    }));
  }

  // 2. Link
  const link = readTextUrl(props.Link);
  if (link) {
    return [{ url: link, type: guessAssetType(link), source: "link" }];
  }

  // 3. Canva
  const canva = readTextUrl(props.Canva);
  if (canva) {
    return [{ url: canva, type: guessAssetType(canva), source: "canva" }];
  }

  // No assets
  return [];
}

// -------------------------------
//  NORMALIZATION
// -------------------------------
function normalizePost(page) {
  const props = page.properties || {};
  const assets = extractAssets(props);
  const isVideo = assets.some(a => a.type === "video");

  return {
    id: page.id,
    title: readTitle(props.Name) || "Untitled",

    publishDate: readDate(props["Publish Date"]),
    caption: readRichText(props.Caption),

    platform: readSelect(props.Platform),
    status: readSelect(props.Status) || "Draft",

    pinned: readCheckbox(props.Pinned),
    hide: readCheckbox(props.Hide),

    assets,
    isVideo,

    createdTime: page.created_time,
    url: page.url,
  };
}

// -------------------------------
//  BUILD FILTERS
// -------------------------------
function buildFilters(posts) {
  const platforms = new Set();
  const statuses = new Set();

  posts.forEach(p => {
    if (p.platform) platforms.add(p.platform);
    if (p.status) statuses.add(p.status);
  });

  return {
    platforms: Array.from(platforms).sort(),
    statuses: Array.from(statuses).sort(),
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
    const resp = await notion.databases.query({
      database_id: NOTION_DB_ID,
      page_size: 100,
      filter: {
        property: "Hide",
        checkbox: { equals: false },
      },
      sorts: [
        { property: "Pinned", direction: "descending" },
        { property: "Publish Date", direction: "descending" },
        { timestamp: "created_time", direction: "descending" },
      ],
    });

    if (!resp || !Array.isArray(resp.results)) {
      return error(res, "Invalid Notion response", 500);
    }

    const items = resp.results.map(normalizePost);
    const filters = buildFilters(items);

    res.status(200).json({
      ok: true,
      dbId: NOTION_DB_ID,
      items,
      filters,
      hasMore: resp.has_more,
      nextCursor: resp.next_cursor,
    });
  } catch (e) {
    console.error("Notion API Error:", e);
    return error(res, e.body?.message || e.message || "Notion query failed", 500);
  }
}
