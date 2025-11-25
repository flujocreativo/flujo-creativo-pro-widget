// /api/health.js
export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    notionToken:
      !!process.env.NOTION_TOKEN ||
      !!process.env.NOTION_API_TOKEN ||
      !!process.env.NOTION_SECRET,
    dbId:
      process.env.NOTION_DB_ID ||
      process.env.NOTION_DATABASE_ID ||
      process.env.NOTION_DB ||
      process.env.NOTION_CONTENT_DB_ID,
    now: new Date().toISOString(),
  });
}
