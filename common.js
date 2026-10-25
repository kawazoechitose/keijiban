/* =========================================================
   掲示板ページと管理ページの両方で使う処理
   ・Supabase との接続
   ・褪色の計算
   ・文字の掲示物を画像として描く
   ・ギザギザの見出し
   ========================================================= */

/* ---------- Supabase との接続 ---------- */
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const BUCKET = "posts";   // 画像の保存場所の名前（setup.sql と同じ）

// 保存した画像の、表示用のアドレス
function imageUrl(path) {
  return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}


/* ---------- 調整用の数値 ---------- */

// 確認用：実際の日数に足す日数。公開するときは 0
const EXTRA_DAYS = 0;

// 褪色の速さ（日）。大きいほどゆっくり
const FADE_DAYS_YELLOW  = 40;
const FADE_DAYS_MAGENTA = 400;
const FADE_DAYS_CYAN    = 3000;
const FADE_DAYS_BLACK   = 400;

// 最終的にどこまで抜けるか（1 = 全部）
const FADE_MAX_YELLOW  = 1;
const FADE_MAX_MAGENTA = 0.75;
const FADE_MAX_CYAN    = 0.3;
const FADE_MAX_BLACK   = 0.05;

// 写真の灰色成分のうち、墨として扱う割合（文字の掲示物は黒インクなので 1）
const BLACK_SHARE_PHOTO = 0.6;
const BLACK_SHARE_TEXT  = 1;

// 規格の大きさ（mm）
const STD_SIZES = [
  ["A2", 420, 594], ["A3", 297, 420], ["A4", 210, 297], ["A5", 148, 210], ["A6", 105, 148],
  ["B3", 364, 515], ["B4", 257, 364], ["B5", 182, 257], ["B6", 128, 182], ["はがき", 100, 148],
];
const TEXT_SIZES = { A4: [210, 297], B5: [182, 257], A5: [148, 210] };


/* ---------- 褪色 ---------- */

let sliderDays = 0;   // 確認用スライダーで足した日数

function daysSince(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, ms / 86400000) + EXTRA_DAYS + sliderDays;
}

function fadeAmounts(days) {
  const curve = (limit, speed) => limit * (1 - Math.exp(-days / speed));
  return {
    y: curve(FADE_MAX_YELLOW, FADE_DAYS_YELLOW),
    m: curve(FADE_MAX_MAGENTA, FADE_DAYS_MAGENTA),
    c: curve(FADE_MAX_CYAN, FADE_DAYS_CYAN),
    k: curve(FADE_MAX_BLACK, FADE_DAYS_BLACK),
  };
}

// 画素を1つずつ、インク（シアン・マゼンタ・イエロー・墨）に分けて抜く
function fadePixels(source, output, f, blackShare) {
  const s = source.data, o = output.data;
  for (let i = 0; i < s.length; i += 4) {
    let c = 255 - s[i], m = 255 - s[i + 1], y = 255 - s[i + 2];
    const k = Math.min(c, m, y) * blackShare;
    c -= k; m -= k; y -= k;
    c *= 1 - f.c; m *= 1 - f.m; y *= 1 - f.y;
    const k2 = k * (1 - f.k);
    o[i] = 255 - (c + k2); o[i + 1] = 255 - (m + k2); o[i + 2] = 255 - (y + k2); o[i + 3] = s[i + 3];
  }
}


/* ---------- 掲示物の元の画素を用意する ---------- */

const sourceCache = new Map();

// 写真：保存先から読み込み、指定の幅以下に縮める
function loadPhoto(url, maxWidth) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";   // 別の場所（Supabase）の画像の画素を読むために必要
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.naturalWidth);
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      try { resolve(ctx.getImageData(0, 0, w, h)); }
      catch (e) { reject(new Error("画素を読めませんでした")); }
    };
    img.onerror = () => reject(new Error("画像を読み込めませんでした：" + url));
    img.src = url;
  });
}

// 文字の掲示物：用紙・見出し・本文・掲示者名を画像として描く
function drawTextFlyer(post, width) {
  const [wmm, hmm] = TEXT_SIZES[post.size] || [post.width_mm || 210, post.height_mm || 297];
  const w = Math.round(width), h = Math.round(width * hmm / wmm);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  const u = w / 210;   // A4の幅210mmを基準にした文字の大きさの単位
  const pad = w * 0.07;
  const family = '"Hiragino Sans", "Yu Gothic", "Noto Sans JP", sans-serif';

  ctx.fillStyle = post.paper || "#ffffff";
  ctx.fillRect(0, 0, w, h);

  let y = h * 0.08;
  ctx.textBaseline = "top";
  ctx.fillStyle = post.ink || "#1c1c1c";
  ctx.font = "800 " + 21 * u + "px " + family;
  y = wrapText(ctx, post.title || "", pad, y, w - pad * 2, 21 * u * 1.25, h * 0.4);

  ctx.fillStyle = "#1c1c1c";
  ctx.font = "400 " + 12 * u + "px " + family;
  wrapText(ctx, post.body || "", pad, y + 10 * u, w - pad * 2, 12 * u * 1.6, h * 0.86);

  ctx.font = "400 " + 10 * u + "px " + family;
  ctx.fillText("掲示者：" + (post.name || "匿名"), pad, h * 0.92);
  return ctx.getImageData(0, 0, w, h);
}

// 1文字ずつ並べ、幅を超えたら改行する（日本語は単語の区切りがないため）
function wrapText(ctx, text, x, y, maxW, lineH, maxY) {
  let line = "";
  for (const ch of text) {
    if (ch === "\n" || ctx.measureText(line + ch).width > maxW) {
      if (y + lineH > maxY) return y;
      ctx.fillText(line, x, y);
      y += lineH;
      line = ch === "\n" ? "" : ch;
    } else line += ch;
  }
  if (line && y + lineH <= maxY + lineH) { ctx.fillText(line, x, y); y += lineH; }
  return y;
}

function getSource(post, maxWidth) {
  const key = post.id + "@" + maxWidth;
  if (!sourceCache.has(key)) {
    sourceCache.set(key, post.kind === "photo"
      ? loadPhoto(imageUrl(post.image_path), maxWidth)
      : Promise.resolve(drawTextFlyer(post, Math.min(maxWidth, 900))));
  }
  return sourceCache.get(key);
}

// 褪色させた掲示物を canvas に描く
async function drawFaded(canvas, post, maxWidth) {
  const source = await getSource(post, maxWidth);
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d");
  const out = ctx.createImageData(source.width, source.height);
  const share = post.kind === "photo" ? BLACK_SHARE_PHOTO : BLACK_SHARE_TEXT;
  fadePixels(source, out, fadeAmounts(daysSince(post.posted_at)), share);
  ctx.putImageData(out, 0, 0);
}


/* ---------- 掲示物の配置 ----------
   掲示した時に1回だけ、大きさと位置をランダムに決めてデータベースに保存する。
   位置は掲示面に対する割合（0〜1）で持つ。掲示面の縦横比はどの画面でも同じ（16:10）。
   判定は、掲示面を横240×縦150のマス目に分けて行う。 */

const BOARD_RATIO = 10 / 16;    // 掲示面の 高さ÷幅（style.css の #board と揃える）
let BOARD_WIDTH_PX = 1400;    // 掲示面の幅（style.css の #board と揃える）
// 掲示物の大きさ（長い方の辺の長さ、px）。見出し「掲示板」の1文字（パソコンで約140px）を目安にしている
//   小さめ：40〜140px（見出しの文字より小さい）
//   中くらい：140〜280px（見出しの文字より大きい）
//   大きい：280〜660px（ごくまれ）
let SIZE_SMALL_MIN_PX = 29;
let SIZE_MEDIUM_MAX_PX = 281;
let SIZE_LARGE_MAX_PX = 949;
let LARGE_CHANCE = 0.04;      // 大きいものになる確率（4%）。残り96%は小さめ〜中くらい

// 長い方の辺の長さをランダムに決める（「何倍か」で均等にばらつかせる）
function randomLongSide() {
  const logRand = (a, b) => a * Math.pow(b / a, Math.random());
  return Math.random() < LARGE_CHANCE
    ? logRand(SIZE_MEDIUM_MAX_PX, SIZE_LARGE_MAX_PX)
    : logRand(SIZE_SMALL_MIN_PX, SIZE_MEDIUM_MAX_PX);
}
let VISIBLE_RATIO = 0.13;     // 下になった掲示物の、見えている面積の下限（13%）
const VISIBLE_BLOCK_CELLS = 4;  // 一続きで見えている部分の下限（マス数。1マス10pxなので約40px）
const TRIES = 40;               // 置き場所を探す回数（見つからなければ少し小さくして探し直す）
const GRID_COLS = 240;          // 判定のマス目の横の数（2400px ÷ 240 = 1マス10px）
const GRID_ROWS = Math.round(GRID_COLS * BOARD_RATIO);

// 保存された位置を、マス目の範囲に直す
function rectOf(post) {
  const w = Math.max(2, Math.round(post.pos_width * GRID_COLS));
  return {
    x: Math.round(post.pos_left * GRID_COLS),
    y: Math.round(post.pos_top * GRID_ROWS),
    w,
    h: Math.max(2, Math.round(w * post.height_mm / post.width_mm)),
  };
}

function paintRect(grid, r, id) {
  for (let y = Math.max(0, r.y); y < Math.min(GRID_ROWS, r.y + r.h); y++) {
    for (let x = Math.max(0, r.x); x < Math.min(GRID_COLS, r.x + r.w); x++) grid[y * GRID_COLS + x] = id;
  }
}

// 掲示物 id の見えている部分が条件を満たすか
function enoughVisible(grid, r, id) {
  let count = 0, total = 0, hasBlock = false;
  const run = new Int16Array(r.w);
  for (let y = r.y; y < r.y + r.h; y++) {
    let width = 0;
    for (let x = 0; x < r.w; x++) {
      const gx = r.x + x;
      const inside = y >= 0 && y < GRID_ROWS && gx >= 0 && gx < GRID_COLS;
      const on = inside && grid[y * GRID_COLS + gx] === id;
      if (inside) total++;
      if (on) count++;
      run[x] = on ? run[x] + 1 : 0;
      width = run[x] >= VISIBLE_BLOCK_CELLS ? width + 1 : 0;
      if (width >= VISIBLE_BLOCK_CELLS) hasBlock = true;
    }
  }
  return count >= total * VISIBLE_RATIO && hasBlock;
}

// 掲示物 id の見えている面積の割合（0〜1）
function visibleRatio(grid, r, id) {
  let count = 0, total = 0;
  for (let y = Math.max(0, r.y); y < Math.min(GRID_ROWS, r.y + r.h); y++) {
    for (let x = Math.max(0, r.x); x < Math.min(GRID_COLS, r.x + r.w); x++) {
      total++;
      if (grid[y * GRID_COLS + x] === id) count++;
    }
  }
  return total ? count / total : 0;
}

// posts：古い順（下から上の順）の一覧。index 番目の掲示物の位置を決めて返す。
// 位置がまだ決まっていない他の掲示物は判定に入れない。
function choosePosition(posts, index) {
  const post = posts[index];
  const aspect = post.height_mm / post.width_mm;
  const others = [];
  posts.forEach((p, i) => { if (i !== index && p.pos_width != null) others.push({ i, r: rectOf(p) }); });

  // 長い方の辺の長さから、幅（掲示面の幅に対する割合）に直す
  const longPx = randomLongSide();
  let size = (aspect > 1 ? longPx / aspect : longPx) / BOARD_WIDTH_PX;
  let chosen = null, best = null, bestScore = -1;
  for (let round = 0; round < 6 && !chosen; round++) {
    for (let t = 0; t < TRIES && !chosen; t++) {
      let w = Math.max(2, Math.round(size * GRID_COLS));
      let h = Math.max(2, Math.round(w * aspect));
      if (h > GRID_ROWS) { h = GRID_ROWS; w = Math.max(2, Math.round(h / aspect)); }
      const rect = { x: Math.floor(Math.random() * (GRID_COLS - w + 1)), y: Math.floor(Math.random() * (GRID_ROWS - h + 1)), w, h };
      // 下から順に塗って、全員の見えている部分を確かめる
      const all = [...others, { i: index, r: rect }].sort((a, b) => a.i - b.i);
      const grid = new Int16Array(GRID_COLS * GRID_ROWS).fill(-1);
      all.forEach((o) => paintRect(grid, o.r, o.i));
      if (all.every((o) => enoughVisible(grid, o.r, o.i))) chosen = rect;
      // 条件を満たす位置が見つからない場合に備えて、一番よく見える位置を覚えておく
      const score = Math.min(...all.map((o) => visibleRatio(grid, o.r, o.i)));
      if (score > bestScore) { bestScore = score; best = rect; }
    }
    size *= 0.85;
  }
  // 見つからなければ、試した中で「一番隠れている掲示物」が一番よく見える位置にする
  const r = chosen || best;
  return { pos_left: r.x / GRID_COLS, pos_top: r.y / GRID_ROWS, pos_width: r.w / GRID_COLS };
}


// 掲示物の近く（中心から少し離れた位置）に、URL の札を置く位置を決める
function refPosNear(post) {
  if (post.pos_width == null) return { pos_left: 0.02 + Math.random() * 0.7, pos_top: 0.03 + Math.random() * 0.9 };
  const h = post.pos_width * (post.height_mm / post.width_mm) / BOARD_RATIO;
  const cx = post.pos_left + post.pos_width / 2, cy = post.pos_top + h / 2;
  const ang = Math.random() * Math.PI * 2;
  const dist = Math.max(post.pos_width, h) / 2 + 0.04 + Math.random() * 0.08;   // 掲示物の外側に出る距離
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  return { pos_left: clamp(cx + Math.cos(ang) * dist, 0.01, 0.85), pos_top: clamp(cy + Math.sin(ang) * dist * 1.6, 0.01, 0.95) };
}

/* ---------- 関連付けの線を描く ----------
   線は、つないだ2枚のうち「下にある方」のすぐ下の高さに描く。
   そのため、線はつないだ掲示物の上には決して重ならず、
   2枚より下にある掲示物（大きな掲示物など）の上では見える。
   掲示物の重なりの高さ（z-index）は 2, 4, 6… の偶数にして、線は奇数（掲示物の1つ下）を使う。
   pairs：[[id, id, 線の種類], …]、center：id → [横, 縦]（掲示面に対する割合）、zOf：id → 掲示物の高さ */

// つながりの種類ごとの線の形（数値は画面上の px）
//   line：直線　dot：点線　dash：破線　wave：なみ線　zigzag：ギザギザ線　chain：一点鎖線
const LINE_KIND = {
  manual: "line",        // 自分でつないだもの
  ref: "dot",            // URL の札
  photo_group: "wave",   // 同じ写真から取り込んだもの
  place: "zigzag",       // 同じ撮影場所
  shot: "dash",          // 同じ撮影時期
  title: "chain",        // 同じ見出し
};
const WAVE_LENGTH_PX = 14, WAVE_HEIGHT_PX = 3;     // なみ線：1つの波の長さ、振れ幅
const ZIGZAG_LENGTH_PX = 8, ZIGZAG_HEIGHT_PX = 3;  // ギザギザ線：1つの山の長さ、振れ幅
const DASH_PATTERN = { dot: "1 3", dash: "6 4", chain: "10 3 1 3" };

function drawLineLayers(board, pairs, center, zOf) {
  const NS = "http://www.w3.org/2000/svg";
  // 掲示面と同じ縦横比の座標にする（なみ線などの形がゆがまないように）
  const W = 1000, H = 1000 * board.clientHeight / board.clientWidth;
  const k = W / board.clientWidth;   // 画面の 1px が座標でいくつか
  pairs.forEach(([a, b, kind]) => {
    const shape = LINE_KIND[kind] || "line";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "links");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    svg.style.zIndex = Math.min(zOf(a), zOf(b)) - 1;
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", linePath(shape, center[a][0] * W, center[a][1] * H, center[b][0] * W, center[b][1] * H, k));
    if (DASH_PATTERN[shape]) path.setAttribute("stroke-dasharray", DASH_PATTERN[shape]);
    svg.appendChild(path);
    board.appendChild(svg);
  });
}

// 線の形を path の d にする
function linePath(shape, x1, y1, x2, y2, k) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const straight = "M" + x1 + " " + y1 + "L" + x2 + " " + y2;
  if (shape !== "wave" && shape !== "zigzag") return straight;
  const ux = (x2 - x1) / len, uy = (y2 - y1) / len;   // 線の向き
  const nx = -uy, ny = ux;                            // 線に直角な向き
  const at = (t, off) => [x1 + ux * t + nx * off, y1 + uy * t + ny * off];
  const step = (shape === "wave" ? WAVE_LENGTH_PX : ZIGZAG_LENGTH_PX) * k;
  const amp = (shape === "wave" ? WAVE_HEIGHT_PX : ZIGZAG_HEIGHT_PX) * k;
  const n = Math.max(1, Math.round(len / step));      // 端がぴったり終わるように山の数を整える
  const seg = len / n;
  let d = "M" + x1 + " " + y1;
  for (let i = 0; i < n; i++) {
    const side = i % 2 ? -1 : 1;
    const end = at(seg * (i + 1), 0);
    if (shape === "wave") {
      const c = at(seg * (i + 0.5), amp * 2 * side);   // 2次曲線の制御点（振れ幅の2倍で、曲線の頂点が振れ幅になる）
      d += "Q" + c[0] + " " + c[1] + " " + end[0] + " " + end[1];
    } else {
      const top = at(seg * (i + 0.5), amp * side);
      d += "L" + top[0] + " " + top[1] + "L" + end[0] + " " + end[1];
    }
  }
  return d;
}

/* ---------- ギザギザの見出し ---------- */
function drawTitle(h1) {
  const text = "掲示板";
  const size = parseFloat(getComputedStyle(h1).fontSize);
  const font = "700 " + size + 'px "Hiragino Sans", "Yu Gothic", "Noto Sans JP", sans-serif';
  let canvas = h1.querySelector("canvas");
  if (!canvas) { canvas = document.createElement("canvas"); h1.appendChild(canvas); }
  const ctx = canvas.getContext("2d");
  ctx.font = font;
  canvas.width = Math.ceil(ctx.measureText(text).width) + 2;
  canvas.height = Math.ceil(size * 1.2);
  ctx.font = font; ctx.textBaseline = "middle"; ctx.fillStyle = "#fff";
  ctx.fillText(text, 1, canvas.height / 2);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height), p = img.data;
  for (let i = 0; i < p.length; i += 4) {
    const on = p[i + 3] >= 110;
    p[i] = p[i + 1] = p[i + 2] = 255; p[i + 3] = on ? 255 : 0;
  }
  ctx.putImageData(img, 0, 0);
}

// 日付の表示（2026.10.23 の形）
function fmtDate(iso) {
  const d = new Date(iso);
  return d.getFullYear() + "." + (d.getMonth() + 1) + "." + d.getDate();
}
