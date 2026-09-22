#!/usr/bin/env node
/**
 * ============================================================
 * 《词缀大冒险》数据管线工具 (Data Pipeline)
 * ============================================================
 * 游戏引擎只读 JSON，不认识任何具体章节。新增章节 = 在
 * data/wordbank.csv (Excel 可直接编辑，另存为 CSV) 里加行，
 * 然后运行本工具，不需要改任何游戏代码。
 *
 * 用法：
 *   node tools/data-tools.mjs export    # CSV -> chapters_config.json + 各章 JSON (含数据校验)
 *   node tools/data-tools.mjs bundle    # 各章 JSON -> data/bundle.js (file:// 直开离线包)
 *   node tools/data-tools.mjs all       # export + bundle (默认)
 *
 * CSV 列 (顺序不限, 表头必须一致, 允许留空的单元格自动继承上一行):
 *   chapter_id      章节唯一ID, 如 chap_neg
 *   chapter_title   章节标题, 如 幻境与反击
 *   chapter_theme   主题英文标识, 用于生成文件名, 如 negative
 *   chapter_name    主题中文名, 如 否定类
 *   chapter_story   章节开场故事
 *   clear_achv_ico  通关成就图标
 *   clear_achv_title 通关成就名称
 *   prefix          前缀, 如 anti-
 *   meaning         前缀含义
 *   school          战斗流派 (可空)
 *   rule            读音同化等特殊规则说明 (可空)
 *   assimilation_group 同化变体组, 用|分隔, 如 in-|im-|il-|ir- (可空)
 *   scene           本关场景隐喻
 *   root / word / cn / difficulty  词根 / 完整单词 / 中文释义 / 难度1-3
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const CSV = path.join(DATA, "wordbank.csv");

const die = (msg) => { console.error("❌ " + msg); process.exit(1); };

/* ---------- CSV 解析 (支持引号转义/逗号/换行/BOM) ---------- */
function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = []; let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* skip */ }
      else field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c && c.trim() !== ""));
}

/* ---------- 命令: export ---------- */
function cmdExport() {
  if (!fs.existsSync(CSV)) die(`找不到词库源表: ${CSV}`);
  const rows = parseCSV(fs.readFileSync(CSV, "utf8"));
  if (rows.length < 2) die("CSV 至少需要表头 + 一行数据");
  const header = rows[0].map(h => h.trim());
  const idx = {}; header.forEach((h, i) => (idx[h] = i));
  const REQUIRED = ["chapter_id", "chapter_title", "chapter_theme", "chapter_name",
    "prefix", "meaning", "scene", "root", "word", "cn", "difficulty"];
  for (const c of REQUIRED) if (!(c in idx)) die(`CSV 缺少列: ${c}`);

  const chapters = []; let ch = null, lv = null; const errors = [];
  const lastCh = {}, lastLv = {}; // 留空继承上一行

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const get = (c) => {
      const v = (idx[c] !== undefined ? (row[idx[c]] || "") : "").trim();
      return v !== "" ? v : "";
    };
    const line = r + 1;

    // --- 章节元数据 (chapter_id 变化时新建章节; 空值继承上一行) ---
    const chId = get("chapter_id") || lastCh.id || "";
    if (chId && (!ch || ch.id !== chId)) {
      const pick = (c, fb) => get(c) || lastCh[c] || fb;
      ch = {
        id: chId,
        title: pick("chapter_title", chId),
        theme: pick("chapter_theme", "misc"),
        themeName: pick("chapter_name", ""),
        story: pick("chapter_story", ""),
        clearAchievement: {
          ico: pick("clear_achv_ico", "🗺️"),
          title: pick("clear_achv_title", `通关「${pick("chapter_title", chId)}」`),
        },
        levels: [],
      };
      chapters.push(ch); lv = null;
      // 前缀元数据的继承不能跨章: 新章节开始时清空上一章的遗留值
      Object.keys(lastLv).forEach(k => delete lastLv[k]);
      Object.assign(lastCh, { id: ch.id, chapter_title: ch.title, chapter_theme: ch.theme,
        chapter_name: ch.themeName, chapter_story: ch.story,
        clear_achv_ico: ch.clearAchievement.ico, clear_achv_title: ch.clearAchievement.title });
    }
    if (!ch) die(`第${line}行: 出现单词但缺少 chapter_id`);

    // --- 关卡(前缀)元数据 (prefix 变化时新建关卡; 空值继承上一行) ---
    const pfx = get("prefix") || lastLv.prefix || "";
    if (pfx && (!lv || lv.prefix !== pfx)) {
      const pick = (c) => get(c) || lastLv[c] || "";
      const grp = get("assimilation_group") || lastLv.assimilation_group || "";
      lv = {
        prefix: pfx,
        meaning: pick("meaning") || "(未填写含义)",
        school: pick("school") || null,
        rule: pick("rule") || null,
        assimilationGroup: grp ? grp.split("|").map(s => s.trim()).filter(Boolean) : null,
        scene: pick("scene") || "",
        words: [],
      };
      ch.levels.push(lv);
      Object.assign(lastLv, { prefix: lv.prefix, meaning: lv.meaning, school: lv.school,
        rule: lv.rule, assimilation_group: grp, scene: lv.scene });
    }
    if (!lv) die(`第${line}行: 出现单词但缺少 prefix`);

    // --- 单词 ---
    const word = get("word"), root = get("root"), cn = get("cn");
    if (!word || !root || !cn) { errors.push(`第${line}行: word / root / cn 不能为空`); continue; }
    if (!word.startsWith(lv.prefix.replace(/-$/, "")))
      errors.push(`第${line}行: "${word}" 不是以 ${lv.prefix} 开头`);
    if (!word.endsWith(root))
      errors.push(`第${line}行: "${word}" 不以词根 "${root}" 结尾`);
    if (lv.assimilationGroup && !lv.assimilationGroup.includes(lv.prefix))
      errors.push(`第${line}行: ${lv.prefix} 的 assimilation_group 未包含自身`);
    lv.words.push({ word, root, cn, difficulty: Number(get("difficulty")) || 1 });
  }

  // 全局单词去重校验
  const seen = new Map();
  chapters.forEach(c => c.levels.forEach(l => l.words.forEach(w => {
    if (seen.has(w.word)) errors.push(`单词重复: ${w.word} (${seen.get(w.word)} 与 ${l.prefix})`);
    seen.set(w.word, l.prefix);
  })));
  if (chapters.length === 0) die("CSV 中没有任何章节数据");
  chapters.forEach(c => { if (c.levels.length === 0) errors.push(`章节 ${c.id} 没有任何关卡`); });

  if (errors.length) {
    console.error("❌ 数据校验失败，共 " + errors.length + " 处:");
    errors.forEach(e => console.error("  - " + e));
    process.exit(1);
  }

  // --- 写文件 ---
  const config = { version: 2, generatedFrom: "data/wordbank.csv", generatedAt: new Date().toISOString(), chapters: [] };
  chapters.forEach((c, i) => {
    const file = `data/chapter_${String(i + 1).padStart(2, "0")}_${c.theme}.json`;
    config.chapters.push({
      id: c.id, title: c.title, theme: c.theme, themeName: c.themeName, story: c.story,
      dataFile: file,
      unlockRequirement: i === 0 ? 0 : chapters[i - 1].id, // 依次解锁
      clearAchievement: c.clearAchievement,
    });
    fs.writeFileSync(path.join(ROOT, file), JSON.stringify({ chapterId: c.id, levels: c.levels }, null, 2) + "\n");
    const wc = c.levels.reduce((n, l) => n + l.words.length, 0);
    console.log(`✔ ${file} — ${c.levels.length} 关 / ${wc} 词`);
  });
  fs.writeFileSync(path.join(DATA, "chapters_config.json"), JSON.stringify(config, null, 2) + "\n");
  console.log(`✔ data/chapters_config.json — ${chapters.length} 章 / ${seen.size} 词 (校验全部通过)`);
}

/* ---------- 命令: bundle ---------- */
function cmdBundle() {
  const cfgPath = path.join(DATA, "chapters_config.json");
  if (!fs.existsSync(cfgPath)) die("缺少 data/chapters_config.json，请先运行 export");
  const config = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const chapters = {};
  for (const c of config.chapters) {
    const p = path.join(ROOT, c.dataFile);
    if (!fs.existsSync(p)) die(`缺少章节文件: ${c.dataFile}`);
    chapters[c.id] = JSON.parse(fs.readFileSync(p, "utf8"));
  }
  const js = "/* 自动生成: node tools/data-tools.mjs bundle —— 请勿手工编辑 */\n"
    + "window.__AFFIX_BUNDLE__ = " + JSON.stringify({ config, chapters }) + ";\n";
  fs.writeFileSync(path.join(DATA, "bundle.js"), js);
  console.log(`✔ data/bundle.js — 已打包 ${config.chapters.length} 章 (file:// 直开离线数据包)`);
}

/* ---------- main ---------- */
const cmd = process.argv[2] || "all";
if (cmd === "export") cmdExport();
else if (cmd === "bundle") cmdBundle();
else if (cmd === "all") { cmdExport(); cmdBundle(); }
else die(`未知命令: ${cmd}\n用法: node tools/data-tools.mjs [export|bundle|all]`);
