/* =========================================================
   見た目の確認ページの動き
   仮の掲示物（文字の掲示物、または自分で選んだ画像）を作り、
   common.js と同じ決め方で大きさ・位置・褪色・線を出す。何も保存しない。
   ========================================================= */

const $ = (id) => document.getElementById(id);

const TITLES = ["探しています", "夏祭りのお知らせ", "ラジオ体操", "防犯パトロール", "資源回収日", "盆踊り大会",
  "会員募集", "落とし物", "清掃活動", "子ども会", "防災訓練", "健康体操教室", "迷い猫", "お礼"];
const PAPERS = ["#ffffff", "#fff3a6", "#ffd3dc", "#cfeaf7", "#ddf0c4"];
const INKS = ["#d8262f", "#1f4fb8", "#1d8a4a", "#ee7a12", "#1c1c1c"];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

let userImages = [];        // 自分で選んだ画像：{ url, w, h }
const imgCache = new Map(); // 画像の画素の覚え

/* ---------- 調整欄 ---------- */
const IDS = ["n", "smin", "mmax", "lmax", "lp", "lmc", "vis", "bw", "age", "grp", "lk"];
const SAMPLE_LINKS = ["https://example.com/matsuri2019", "夏祭りの記事", "https://example.jp/event/radio-taiso", "町会のお知らせ", "https://example.org/news/123"];
function readControls() {
  const v = {};
  IDS.forEach((id) => { v[id] = Number($(id).value); $(id + "-v").textContent = $(id).value; });
  return v;
}

// 調整欄の値を common.js の数値に反映する
function applySettings(v) {
  SIZE_SMALL_MIN_PX = v.smin;
  SIZE_MEDIUM_MAX_PX = Math.max(v.smin + 1, v.mmax);
  SIZE_LARGE_MAX_PX = Math.max(SIZE_MEDIUM_MAX_PX + 1, v.lmax);
  LARGE_CHANCE = v.lp / 100;
  LARGE_MAX_COUNT = v.lmc;
  VISIBLE_RATIO = v.vis / 100;
  BOARD_WIDTH_PX = v.bw;
  $("board").style.width = v.bw + "px";
  // common.js に書き写すための値
  $("out").textContent =
`この見た目にするには、次の値を書き換える
common.js ：
  let BOARD_WIDTH_PX = ${v.bw};
  let SIZE_SMALL_MIN_PX = ${SIZE_SMALL_MIN_PX};
  let SIZE_MEDIUM_MAX_PX = ${SIZE_MEDIUM_MAX_PX};
  let SIZE_LARGE_MAX_PX = ${SIZE_LARGE_MAX_PX};
  let LARGE_CHANCE = ${LARGE_CHANCE};
  let LARGE_MAX_COUNT = ${LARGE_MAX_COUNT};
  let VISIBLE_RATIO = ${VISIBLE_RATIO};
style.css ：
  #board { ... width: ${v.bw}px; ... }`;
}

/* ---------- 仮の掲示物を作る ---------- */
function makePosts(v) {
  const posts = [];
  const groups = Math.max(1, v.grp);
  for (let i = 0; i < v.n; i++) {
    const posted = new Date(Date.now() - Math.random() * v.age * 86400000).toISOString();
    const group = v.grp ? "g" + Math.floor(Math.random() * groups * 3) : null;   // 仲間（同じ写真に見立てる）
    if (userImages.length && Math.random() < 0.7) {
      const img = pick(userImages);
      posts.push({ id: "d" + i, kind: "img", url: img.url, width_mm: img.w, height_mm: img.h, posted_at: posted, group });
    } else {
      const size = pick(["A4", "B5", "A5"]);
      const [w, h] = TEXT_SIZES[size];
      posts.push({ id: "d" + i, kind: "text", title: pick(TITLES), body: "日時：10月○日（土）\n場所：○○公園\n詳しくは町会まで。",
        name: "", paper: pick(PAPERS), ink: pick(INKS), size, width_mm: w, height_mm: h, posted_at: posted, group });
    }
  }
  return posts.sort((a, b) => a.posted_at.localeCompare(b.posted_at));
}

/* ---------- 並べる ---------- */
function render() {
  const v = readControls();
  applySettings(v);
  const posts = makePosts(v);
  posts.forEach((p, i) => Object.assign(p, choosePosition(posts, i)));

  const board = $("board");
  board.textContent = "";
  posts.forEach((post, i) => {
    const box = document.createElement("div");
    box.className = "post";
    box.style.left = post.pos_left * 100 + "%";
    box.style.top = post.pos_top * 100 + "%";
    box.style.width = post.pos_width * 100 + "%";
    box.style.aspectRatio = post.width_mm + " / " + post.height_mm;
    box.style.zIndex = (i + 1) * 2;
    const cv = document.createElement("canvas");
    box.appendChild(cv);
    board.appendChild(box);
    drawPreview(cv, post);
  });
  // リンク（URL の札）：ランダムな掲示物の近くに置き、その掲示物と線で結ぶ
  const refs = [];
  for (let k = 0; k < v.lk && posts.length; k++) {
    const post = pick(posts);
    const pos = refPosNear(post);
    const a = document.createElement("a");
    a.className = "ref"; a.href = "#"; a.textContent = pick(SAMPLE_LINKS);
    a.style.left = pos.pos_left * 100 + "%"; a.style.top = pos.pos_top * 100 + "%";
    a.addEventListener("click", (e) => e.preventDefault());
    board.appendChild(a);
    refs.push({ el: a, post });
  }
  drawLines(posts, refs);
}

async function drawPreview(canvas, post) {
  let src;
  if (post.kind === "img") {
    if (!imgCache.has(post.url)) imgCache.set(post.url, loadPhoto(post.url, 700));
    src = await imgCache.get(post.url);
  } else {
    src = drawTextFlyer(post, 400);
  }
  canvas.width = src.width; canvas.height = src.height;
  const ctx = canvas.getContext("2d");
  const out = ctx.createImageData(src.width, src.height);
  fadePixels(src, out, fadeAmounts(fadeDaysSince(post.posted_at)), post.kind === "img" ? BLACK_SHARE_PHOTO : BLACK_SHARE_TEXT);
  ctx.putImageData(out, 0, 0);
}

// 同じ仲間同士を、近いものから順に線で結ぶ（線はつないだ2枚の下を通る）
function drawLines(posts, refs) {
  const center = {}, rects = {};
  posts.forEach((p) => {
    const hFrac = p.pos_width * (p.height_mm / p.width_mm) / BOARD_RATIO;
    center[p.id] = [p.pos_left + p.pos_width / 2, p.pos_top + hFrac / 2];
    rects[p.id] = [p.pos_left, p.pos_top, p.pos_width, hFrac];
  });
  const g = {};
  posts.forEach((p) => { if (p.group) (g[p.group] = g[p.group] || []).push(p.id); });
  const pairs = [];
  const kind = pick(["photo_group", "shot", "manual", "place", "title"]);   // 本番と同じく、関連付けの線は1種類だけ
  Object.values(g).filter((ids) => ids.length >= 2).slice(0, Number($("grp").value)).forEach((ids) => {
    const done = [ids[0]], rest = ids.slice(1);
    const d = (a, b) => Math.hypot(center[a][0] - center[b][0], (center[a][1] - center[b][1]) * BOARD_RATIO);
    while (rest.length) {
      let best = null;
      done.forEach((a) => rest.forEach((b, j) => { const x = d(a, b); if (!best || x < best.x) best = { a, b, j, x }; }));
      pairs.push([best.a, best.b, kind]); done.push(best.b); rest.splice(best.j, 1);
    }
  });
  // URL の札とつないだ掲示物
  const board = $("board");
  refs.forEach((r, k) => {
    center["ref" + k] = [(r.el.offsetLeft + r.el.offsetWidth / 2) / board.clientWidth, (r.el.offsetTop + r.el.offsetHeight / 2) / board.clientHeight];
    pairs.push(["ref" + k, r.post.id, "ref"]);
  });
  const z = {};
  posts.forEach((q, i) => { z[q.id] = (i + 1) * 2; });
  drawLineLayers(board, pairs, center, (id) => (id in z ? z[id] : 1e6), rects);
}

/* ---------- 操作 ---------- */
let timer = null;
IDS.forEach((id) => $(id).addEventListener("input", () => {
  readControls();
  clearTimeout(timer);
  timer = setTimeout(render, 250);   // 動かし終わってから並べ直す
}));
$("redo").addEventListener("click", render);

// 自分の画像を読み込む（このパソコンの中だけで使う。どこにも送らない）
$("imgs").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  for (const f of files) {
    const url = URL.createObjectURL(f);
    const size = await new Promise((res) => { const im = new Image(); im.onload = () => res([im.naturalWidth, im.naturalHeight]); im.onerror = () => res(null); im.src = url; });
    if (size) userImages.push({ url, w: size[0], h: size[1] });
  }
  render();
});
$("clear-imgs").addEventListener("click", () => { userImages = []; render(); });

drawTitle($("title"));
if (document.fonts) document.fonts.ready.then(() => drawTitle($("title")));
render();
