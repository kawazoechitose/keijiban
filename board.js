/* =========================================================
   掲示板ページの動き
   1. 掲示物を Supabase から読み込む
   2. 大きさと位置をランダムに決めて重ねて並べる
   3. 拡大表示
   4. 申請書
   5. 確認用スライダー（#kanri）
   ========================================================= */

const $ = (id) => document.getElementById(id);

/* ---------- 数値 ---------- */
const BOARD_IMAGE_MAX = 1000;  // 一覧の画像の最大幅（px）
// 大きさ・位置の決め方の数値は common.js にある

let POSTS = [];
let LINKS = [];
let REFS = [];       // 関連する情報（URL）
let REF_POSTS = [];  // URL とつながる掲示物の組
const placed = [];


/* ---------- 1. 読み込み ---------- */
async function loadPosts() {
  const { data, error } = await sb.from("posts").select("*").order("posted_at", { ascending: true });
  if (error) {
    $("note").hidden = false;
    $("note").textContent = "掲示物を読み込めませんでした（" + error.message + "）";
    return;
  }
  POSTS = data.map((p) => ({ ...p, width_mm: p.width_mm || 210, height_mm: p.height_mm || 297 }));
  const res = await sb.from("links").select("a,b");   // 手動でつないだ組（まだ準備していなければ空のまま）
  LINKS = res.error ? [] : res.data;
  const r1 = await sb.from("refs").select("*");
  const r2 = await sb.from("ref_posts").select("ref_id,post_id");
  REFS = r1.error ? [] : r1.data;
  REF_POSTS = r2.error ? [] : r2.data;
  buildBoard();
}


/* ---------- 2. 並べる ---------- */
// 位置は掲示した時に決めて保存してある。まだ位置がない掲示物（管理ページを開く前に掲示されたもの）だけ、
// この画面でだけ仮の位置を決める（保存はしない。管理ページを開くと保存される）

function buildBoard() {
  const board = $("board");
  board.textContent = "";
  placed.length = 0;
  if (!POSTS.length) {
    $("note").hidden = false;
    $("note").textContent = "現在、掲示物はありません。";
    return;
  }
  const list = POSTS.map((p) => ({ ...p }));
  list.forEach((p, i) => { if (p.pos_width == null) Object.assign(p, choosePosition(list, i)); });
  POSTS.forEach((post, i) => {
    const pos = list[i];
    const box = document.createElement("button");
    box.type = "button";
    box.className = "post";
    box.setAttribute("aria-label", (post.title || "掲示物") + " を拡大");
    box.style.left = pos.pos_left * 100 + "%";
    box.style.top = pos.pos_top * 100 + "%";
    box.style.width = pos.pos_width * 100 + "%";
    box.style.aspectRatio = post.width_mm + " / " + post.height_mm;
    box.style.zIndex = (i + 1) * 2;   // 新しいものほど上（2, 4, 6…。間の奇数は線に使う）
    const canvas = document.createElement("canvas");
    box.appendChild(canvas);
    board.appendChild(box);
    drawFaded(canvas, post, BOARD_IMAGE_MAX).catch((e) => console.error(e.message));
    placed.push({ canvas, post });
    box.addEventListener("click", () => openViewer(post));
  });
  placeRefs();
  drawLinks(list);
}

// 関連する情報（URL）を、掲示面の保存された位置に文字として置く。押すとそのサイトが別のタブで開く
function placeRefs() {
  REFS.forEach((r) => {
    const a = document.createElement("a");
    a.className = "ref";
    a.href = r.url; a.target = "_blank"; a.rel = "noopener noreferrer";
    a.textContent = r.label || r.url;
    a.style.left = (r.pos_left ?? 0.05) * 100 + "%";
    a.style.top = (r.pos_top ?? 0.05) * 100 + "%";
    a.dataset.ref = r.id;
    $("board").appendChild(a);
  });
}


/* ---------- 関連付けの線 ----------
   ・手動でつないだ組：いつも表示
   ・自動の関連付け：「同じ写真」「同じ撮影場所」「同じ撮影時期」「同じ見出し」をすべて表示
     （線の形はつながりの種類ごとに変える。common.js の LINE_KIND）
     （同じ仲間が3枚以上あるときは、近いもの同士を順に結んで1本の木の形にする） */
const AUTO_KEYS = ["photo_group", "place", "shot", "title"];

function drawLinks(list) {
  // 掲示物の中心（掲示面に対する割合）
  const center = {};
  list.forEach((p) => {
    const hFrac = p.pos_width * (p.height_mm / p.width_mm) / BOARD_RATIO;
    center[p.id] = [p.pos_left + p.pos_width / 2, p.pos_top + hFrac / 2];
  });
  const pairs = LINKS.filter((l) => center[l.a] && center[l.b]).map((l) => [l.a, l.b, "manual"]);

  // URL の文字の中心（置いた後の実際の大きさから計算する）
  const board = $("board");
  board.querySelectorAll(".ref").forEach((el) => {
    center["ref:" + el.dataset.ref] = [
      (el.offsetLeft + el.offsetWidth / 2) / board.clientWidth,
      (el.offsetTop + el.offsetHeight / 2) / board.clientHeight,
    ];
  });
  REF_POSTS.forEach((x) => { if (center["ref:" + x.ref_id] && center[x.post_id]) pairs.push(["ref:" + x.ref_id, x.post_id, "ref"]); });

  // 自動：すべての項目について、仲間が2枚以上いれば線を引く
  const groupsOf = (key) => {
    const g = {};
    list.forEach((p) => {
      let v = p[key];
      if (key === "title" && v) v = v.replace(/\s+/g, "");   // 見出しは空白の違いを無視して比べる
      if (v) (g[v] = g[v] || []).push(p.id);
    });
    return Object.values(g).filter((ids) => ids.length >= 2);
  };
  AUTO_KEYS.forEach((key) => {
    groupsOf(key).forEach((ids) => nearestTree(ids, center).forEach(([a, b]) => pairs.push([a, b, key])));
  });

  if (!pairs.length) return;
  // 掲示物の高さ（古い順に 2, 4, 6…）。URL の札は一番上にあるので、相手の掲示物の高さで決まる
  const z = {};
  list.forEach((p, i) => { z[p.id] = (i + 1) * 2; });
  drawLineLayers($("board"), pairs, center, (id) => (id in z ? z[id] : 1e6));
}

// 近いもの同士を順に結んで、全員がつながる最短の組み合わせを作る
function nearestTree(ids, center) {
  const done = [ids[0]], rest = ids.slice(1), edges = [];
  const d = (a, b) => Math.hypot(center[a][0] - center[b][0], (center[a][1] - center[b][1]) * BOARD_RATIO);
  while (rest.length) {
    let best = null;
    done.forEach((a) => rest.forEach((b, j) => { const v = d(a, b); if (!best || v < best.v) best = { a, b, j, v }; }));
    edges.push([best.a, best.b]);
    done.push(best.b);
    rest.splice(best.j, 1);
  }
  return edges;
}

function redrawAll() {
  placed.forEach(({ canvas, post }) => drawFaded(canvas, post, BOARD_IMAGE_MAX).catch(() => {}));
  if (!$("viewer").hidden && viewingPost) openViewer(viewingPost);
}


/* ---------- 3. 拡大表示 ---------- */
let viewingPost = null;

function openViewer(post) {
  viewingPost = post;
  $("viewer-days").textContent = "掲示から" + Math.floor(daysSince(post.posted_at)) + "日";
  drawFaded($("viewer-canvas"), post, 1400).catch((e) => console.error(e.message));
  const info = $("viewer-info");
  info.textContent = "";
  const rows = [
    ["見出し", post.title],
    ["掲示許可", "許可済み（" + fmtDate(post.posted_at) + "）"],
    ["大きさ", post.size_label],   // 申請された掲示物だけ（A4 など）。写真は大きさを持たない
    ["撮影場所", post.place],
    ["撮影時期", post.shot],
    ["出典", post.source],
  ];
  rows.forEach(([k, v]) => {
    if (!v) return;
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    info.append(dt, dd);
  });
  // 関連する情報：この掲示物とつながっている URL をリンクとして出す（別のタブで開く）
  const myRefs = REFS.filter((r) => REF_POSTS.some((x) => x.ref_id === r.id && x.post_id === post.id));
  if (myRefs.length) {
    const dt = document.createElement("dt"); dt.textContent = "関連する情報";
    const dd = document.createElement("dd");
    myRefs.forEach((r) => {
      const a = document.createElement("a");
      a.href = r.url; a.textContent = r.label || r.url; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.style.display = "block"; a.style.color = "inherit";
      dd.append(a);
    });
    info.append(dt, dd);
  }
  $("viewer").hidden = false;
}


/* ---------- 4. 申請書 ----------
   文字で掲示物を作る申請はやめた。「掲示を申請する」は写真の投稿ページ（submit.html）を開く */


/* ---------- 5. 確認用スライダー ---------- */
let adminReady = false;
let isAdmin = false;   // 管理者としてログインしているか（showAdminLink で分かる）
function setupAdmin() {
  if (!isAdmin || location.hash !== "#kanri" || adminReady) return;
  adminReady = true;
  $("admin").hidden = false;
  let waiting = false;
  $("age").addEventListener("input", () => {
    sliderDays = Number($("age").value);
    $("age-out").textContent = "+" + sliderDays + "日";
    if (waiting) return;
    waiting = true;
    requestAnimationFrame(() => { waiting = false; redrawAll(); });
  });
}


/* ---------- 共通の操作 ---------- */
document.querySelectorAll("[data-close]").forEach((b) =>
  b.addEventListener("click", () => { $(b.dataset.close).hidden = true; }));
document.querySelectorAll(".scrim").forEach((s) =>
  s.addEventListener("click", (e) => { if (e.target === s) s.hidden = true; }));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.querySelectorAll(".scrim").forEach((s) => (s.hidden = true));
});

window.addEventListener("resize", () => drawTitle($("title")));
window.addEventListener("hashchange", setupAdmin);


/* ---------- 管理ページへのボタン ----------
   このブラウザで管理ページにログインしたことがあり、その人が管理者として登録されている場合だけ表示する */
async function showAdminLink() {
  const { data } = await sb.auth.getSession();
  const user = data && data.session && data.session.user;
  if (!user) return;
  const res = await sb.from("admins").select("user_id").eq("user_id", user.id);
  if (res.data && res.data.length) {
    $("admin-link").hidden = false;
    isAdmin = true;
    setupAdmin();   // 確認用スライダーは管理者にだけ出す
  }
}


/* ---------- はじめに実行 ---------- */
drawTitle($("title"));
if (document.fonts) document.fonts.ready.then(() => drawTitle($("title")));
setupAdmin();
loadPosts();
showAdminLink();
