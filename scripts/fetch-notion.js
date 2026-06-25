#!/usr/bin/env node
/**
 * Notion DB から「導入決定」「大会終了」の大会を取得し、
 * 公開用の competitions.json を生成する。
 *
 * 必要な環境変数:
 *   NOTION_TOKEN  - Notion インテグレーションのシークレット
 *   NOTION_DB_ID  - 対象データベースの ID
 *
 * 公開してよい情報だけを出力する(管理リンク・参加人数・契約書などは出さない)。
 */

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_ID = process.env.NOTION_DB_ID;
const NOTION_VERSION = "2022-06-28";

// カレンダーに載せる状態(Status型の選択肢名)
const VISIBLE_STATES = ["導入決定", "大会終了"];

// プロパティ名(Notion DB の実際の列名に合わせる)
const PROP = {
  title: "大会名（競技日）",
  period: "開催期間（設営日）",
  status: "状態",
  live: "ライブリザルト",
};

if (!NOTION_TOKEN || !NOTION_DB_ID) {
  console.error("ERROR: 環境変数 NOTION_TOKEN と NOTION_DB_ID が必要です。");
  process.exit(1);
}

async function queryDatabase() {
  const results = [];
  let cursor = undefined;

  do {
    const body = {
      page_size: 100,
      filter: {
        or: VISIBLE_STATES.map((s) => ({
          property: PROP.status,
          status: { equals: s },
        })),
      },
      sorts: [{ property: PROP.period, direction: "ascending" }],
    };
    if (cursor) body.start_cursor = cursor;

    const res = await fetch(
      `https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${NOTION_TOKEN}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Notion API ${res.status}: ${text}`);
    }

    const data = await res.json();
    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return results;
}

/** タイトルプロパティから純粋な文字列を取り出す */
function readTitle(prop) {
  if (!prop || prop.type !== "title") return "";
  return prop.title.map((t) => t.plain_text).join("").trim();
}

/** 大会名から会場名(@以降)を切り出す。例: "0620近畿高校@京都" -> "京都" */
function extractVenue(name) {
  const idx = name.lastIndexOf("@");
  if (idx === -1) return "";
  return name.slice(idx + 1).trim();
}

/**
 * 大会名を表示用に分解する。
 *   - 先頭・中間の [新] / [RG] などのタグを全て tags に抜き出す
 *   - @以降の会場名を venue に分離
 *   - 残りを表示名 name とする(日付プレフィックスは残す: 検索・並び順の手がかりになるため)
 * 例: "0613[RG]近畿高校@京都" -> name:"0613近畿高校", tags:["RG"], venue:"京都"
 *     "[新]0814姫路市民大会"  -> name:"0814姫路市民大会", tags:["新"], venue:""
 */
function parseName(rawName) {
  const tags = [];
  // 位置を問わず [..] タグを全て抜き出す
  let name = rawName.replace(/\[([^\]]+)\]/g, (_, t) => {
    tags.push(t.trim());
    return "";
  });
  // 会場を分離
  const venue = extractVenue(name);
  const atIdx = name.lastIndexOf("@");
  if (atIdx !== -1) name = name.slice(0, atIdx);
  return { name: name.trim(), tags, venue };
}

function main() {
  return queryDatabase().then((pages) => {
    const events = [];

    for (const page of pages) {
      const props = page.properties;
      const rawTitle = readTitle(props[PROP.title]);
      if (!rawTitle) continue;

      const periodProp = props[PROP.period];
      const date = periodProp && periodProp.date;
      if (!date || !date.start) continue; // 日付未設定はスキップ

      const statusProp = props[PROP.status];
      const status =
        statusProp && statusProp.status ? statusProp.status.name : "";

      const { name, tags, venue } = parseName(rawTitle);

      // ライブリザルト(URL型)。未設定なら空文字。
      const liveProp = props[PROP.live];
      const liveUrl = liveProp && liveProp.url ? liveProp.url : "";

      events.push({
        id: page.id,
        title: rawTitle, // 元の表記そのまま(0620近畿高校@京都)
        name, // タグ・会場を含む表示名
        tags, // ["新"], ["RG"] など
        venue, // 京都 / 神戸 など
        start: date.start, // YYYY-MM-DD
        end: date.end || date.start, // 単日の場合は start と同じ
        status, // 導入決定 / 大会終了
        liveUrl, // ライブリザルトURL(無ければ空)
      });
    }

    // 開始日でソート
    events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

    const output = {
      generatedAt: new Date().toISOString(),
      count: events.length,
      events,
    };

    return output;
  });
}

main()
  .then((output) => {
    const fs = require("fs");
    const path = require("path");
    const outDir = path.join(__dirname, "..", "public");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, "competitions.json");
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");
    console.log(`OK: ${output.count} 件を ${outPath} に書き出しました。`);
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
