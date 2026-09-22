// 轻量 DOM 桩 + 数据驱动架构冒烟测试
// 验证: 外部 JSON 加载 → 引擎初始化 → 核心玩法 → 同化规则 → 成就/存档
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = __dirname;

// ---- stubs ----
const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};
global.window = {};

function makeEl(id) {
  const el = {
    id: id || "",
    parentElement: null,
    style: {},
    dataset: {},
    children: [],
    _classes: new Set(),
    _innerHTML: "",
    classList: {
      add: (...c) => c.forEach(x => el._classes.add(x)),
      remove: (...c) => c.forEach(x => el._classes.delete(x)),
      toggle: (c, f) => { f ? el._classes.add(c) : el._classes.delete(c); },
      contains: c => el._classes.has(c)
    },
    appendChild: c => { el.children.push(c); return c; },
    remove: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, bottom: 100, width: 100, height: 100 }),
    focus: () => {}, click: () => {}, setAttribute: () => {},
    offsetHeight: 0,
    querySelectorAll: () => []
  };
  Object.defineProperty(el, "innerHTML", {
    get() { return el._innerHTML; },
    set(v) { el._innerHTML = v; el.children = []; }
  });
  Object.defineProperty(el, "className", {
    get() { return [...el._classes].join(" "); },
    set(v) { el._classes = new Set(v.split(/\s+/).filter(Boolean)); }
  });
  Object.defineProperty(el, "textContent", {
    get() { return el._innerHTML; },
    set(v) { el._innerHTML = v; }
  });
  Object.defineProperty(el, "title", { get() { return ""; }, set() {} });
  return el;
}

const els = {};
global.document = {
  getElementById: id => (els[id] = els[id] || makeEl(id)),
  querySelectorAll: () => [],
  createElement: () => makeEl(),
  createElementNS: () => makeEl(),
  addEventListener: () => {}
};
const setTimeout_real = setTimeout;

// ---- 读取数据文件 (管线产物) ----
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "data/chapters_config.json"), "utf8"));
const chapterMap = {};
for (const c of config.chapters) {
  chapterMap[c.id] = JSON.parse(fs.readFileSync(path.join(ROOT, c.dataFile), "utf8"));
}

// ---- 执行引擎脚本 ----
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const ctx = vm.createContext({
  localStorage: global.localStorage, window: global.window, document: global.document,
  setTimeout: (fn, t) => { setTimeout_real(fn, Math.min(t || 0, 5)); },
  clearTimeout, console, AudioContext: undefined, fetch: undefined
});
vm.runInContext(script, ctx, { filename: "game.js" });

const G = {
  get Catalog(){ return vm.runInContext("Catalog", ctx); },
  get UI(){ return vm.runInContext("UI", ctx); },
  get Game(){ return vm.runInContext("Game", ctx); },
  get SAVE(){ return vm.runInContext("SAVE", ctx); },
  initGameData: (cfg, map) => vm.runInContext("initGameData(config, chapterMap)", Object.assign(ctx, { config: cfg, chapterMap: map })),
  startGame: () => vm.runInContext("startGame()", ctx),
  closeModal: () => vm.runInContext("closeModal()", ctx)
};

const assert = (cond, msg) => {
  if (!cond) { console.error("❌ FAIL:", msg); process.exitCode = 1; }
  else console.log("✅", msg);
};

const sleep = ms => new Promise(r => setTimeout_real(r, ms));

(async () => {
  // ---- 1. 数据装配 ----
  G.initGameData(config, chapterMap);
  G.startGame();
  const CAT = G.Catalog.chapters;
  assert(CAT.length === 3, "数据驱动: 从外部 JSON 装配 3 个章节");
  assert(CAT[0].levels.length === 12, "第一章(否定类) 12 个前缀关卡");
  assert(CAT[1].levels.length === 11, "第二章(空间类) 11 个前缀关卡");
  assert(CAT[2].levels.length === 4, "第三章(数字类) 4 个前缀关卡");
  assert(CAT.map(c => c.requirement).join(",") === "0,chap_neg,chap_spatial", "章节依次解锁链正确");

  const allWords = [];
  CAT.forEach(c => c.levels.forEach(l => {
    assert(!!l.scene && !!l.meaning, `${l.prefix} 关卡元数据完整`);
    l.words.forEach(w => {
      assert(w.word.startsWith(l.prefix.replace(/-$/, "")), `词形一致: ${l.prefix}+${w.root}=${w.word}`);
      assert(w.word.endsWith(w.root), `词根匹配: ${w.word} ⊇ ${w.root}`);
      assert(!!w.cn, `释义完整: ${w.word}`);
      allWords.push(w.word);
    });
  }));
  assert(new Set(allWords).size === allWords.length, `无重复单词 (${allWords.length} 词)`);

  // ---- 2. 导航 ----
  G.UI.goMap(); G.UI.goDict(); G.UI.goAchv(); G.UI.goWrong(); G.UI.goHome();
  assert(true, "界面导航无异常");
  assert(els["home-foot"].innerHTML.includes("3"), "首页显示动态章节数");

  // ---- 3. 同化规则机制 (im- 关卡 = 第一章第10关, index 9) ----
  G.Game.start(0, 9);
  assert(G.Game.lv.prefix === "im-", "进入 im- 关卡");
  const optHTML = els["g-options"]._innerHTML;
  ["in-", "im-", "il-", "ir-"].forEach(p =>
    assert(optHTML.includes(`>${p}<`), `同化组互为干扰项: 选项含 ${p}`));
  assert(els["g-speech"].innerHTML.includes("读音守卫"), "气泡显示读音同化规则提示");
  G.Game.attempt("in-", null); // im- 关卡选 in- 是错的
  assert(G.Game.hp === 2, "同化选错扣血");
  assert(els["g-speech"].innerHTML.includes("💡"), "答错时反馈同化规则教学");
  assert(G.SAVE.wrongWords.includes(G.Game.words[0].word), "错词记入错题本");
  G.Game.attempt("im-", null);
  await sleep(30);
  assert(G.Game.idx === 1, "答对后进入下一题");

  // ---- 4. 完整通关第二章第1关 (pro-): 1次失误 → 2星 ----
  G.Game.start(1, 0);
  assert(G.Game.lv.prefix === "pro-", "进入 pro- 关卡");
  const nWords = CAT[1].levels[0].words.length;
  for (let i = 0; i < nWords; i++) {
    G.Game.phase = "combine";
    if (i === 0) G.Game.attempt("sub-", null);
    G.Game.attempt(G.Game.lv.prefix, null);
    await sleep(30);
  }
  await sleep(50);
  assert(G.Game.phase === "match", "自动进入词义连线阶段");
  for (const w of G.Game.learned) {
    const a = makeEl(); a.dataset.w = w.word; a.parentElement = makeEl("mc-left");
    const b = makeEl(); b.dataset.w = w.word; b.parentElement = makeEl("mc-right");
    G.Game.pick("L", a); G.Game.pick("R", b);
  }
  assert(G.Game.matched === G.Game.learned.length, "连线全部配对成功");
  await sleep(30);
  assert(els["modal-box"]._innerHTML.includes("关卡通过"), "弹出通关结算");
  assert(G.SAVE.stars["chap_spatial"][0] === 2, "1次失误 → 2星 (按章节ID存档)");
  assert(G.SAVE.cards.includes("pro-"), "解锁 pro- 前缀卡牌");
  assert(G.SAVE.achievements.includes("first"), "成就「初出茅庐」解锁");
  assert(!G.SAVE.achievements.includes("clear_chap_neg"), "章节通关成就未误发");

  // ---- 5. 失败流程 ----
  G.closeModal();
  G.Game.start(1, 0);
  G.Game.attempt("sub-", null); G.Game.attempt("ex-", null); G.Game.attempt("over-", null);
  await sleep(30);
  assert(els["modal-box"]._innerHTML.includes("心用完了"), "3次答错 → 失败弹窗");

  // ---- 6. 完美通关 → 3星 + 成就 ----
  G.closeModal();
  G.Game.start(1, 1);
  const n2 = CAT[1].levels[1].words.length;
  for (let i = 0; i < n2; i++) { G.Game.attempt(G.Game.lv.prefix, null); await sleep(30); }
  await sleep(50);
  for (const w of G.Game.learned) {
    const a = makeEl(); a.dataset.w = w.word; a.parentElement = makeEl("mc-left");
    const b = makeEl(); b.dataset.w = w.word; b.parentElement = makeEl("mc-right");
    G.Game.pick("L", a); G.Game.pick("R", b);
  }
  await sleep(30);
  assert(G.SAVE.stars["chap_spatial"][1] === 3, "零失误 → 3星");
  assert(G.SAVE.achievements.includes("perfect"), "成就「完美词猎人」解锁");
  assert(G.SAVE.cards.includes("with-"), "解锁 with- 前缀卡牌");

  // ---- 7. 存档 v2 持久化 ----
  vm.runInContext("persist()", ctx);
  assert(global.localStorage.getItem("affixAdventureSave_v2").includes("chap_spatial"), "localStorage v2 存档写入");

  // ---- 8. 离线数据包校验 ----
  const bundle = fs.readFileSync(path.join(ROOT, "data/bundle.js"), "utf8");
  assert(bundle.includes("chap_neg") && bundle.includes("chap_spatial") && bundle.includes("chap_number"), "bundle.js 含全部章节");
  assert(!script.includes("antibody") && !script.includes("transport"), "引擎代码已与词库数据完全解耦");

  console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部冒烟测试通过 ==");
})();
