/* =========================================================
   写真から取り込む画面（管理ページと投稿ページで共通）
   ・写真の読み込み、切り詰め、変形、掲示物の四隅の指定、撮影時期の自動入力
   ・「まとめて〜する」を押したときの、保存のしかただけはページごとに違う
     （各ページが TOOL.handler を決める）
   ========================================================= */

const $ = (id) => document.getElementById(id);

// 保存する画像の長辺の上限（px）と画質（0〜1）
const SAVE_LONG_SIDE = 1600;
const SAVE_QUALITY = 0.85;


/* ---------- 撮影時期 ----------
   入力欄は「年と月を選ぶ」形（2019-07）。保存するときは「2019年7月」の形にする */
function monthToText(v) {
  const m = /^(\d{4})-(\d{2})$/.exec(v || "");
  return m ? m[1] + "年" + Number(m[2]) + "月" : "";
}
function textToMonth(t) {
  const m = /(\d{4})年(\d{1,2})月/.exec(t || "");
  return m ? m[1] + "-" + m[2].padStart(2, "0") : "";
}

// JPEG の写真に記録された撮影日（Exif）を読む。見つかれば「2019-07」の形で返す
function exifMonth(buf) {
  try {
    const v = new DataView(buf);
    if (v.getUint16(0) !== 0xffd8) return null;   // JPEG ではない
    let o = 2;
    while (o + 4 < v.byteLength) {
      const marker = v.getUint16(o), len = v.getUint16(o + 2);
      if ((marker & 0xff00) !== 0xff00) return null;
      if (marker === 0xffe1 && v.getUint32(o + 4) === 0x45786966) return readTiffDate(v, o + 10);
      o += 2 + len;
    }
  } catch (e) { /* 読めなければ何もしない */ }
  return null;
}
function readTiffDate(v, t) {
  const le = v.getUint16(t) === 0x4949;
  const u16 = (p) => v.getUint16(p, le), u32 = (p) => v.getUint32(p, le);
  const readIFD = (off) => {
    const n = u16(t + off), tags = {};
    for (let i = 0; i < n; i++) { const e = t + off + 2 + i * 12; tags[u16(e)] = { count: u32(e + 4), val: e + 8 }; }
    return tags;
  };
  const str = (tag) => {
    const off = tag.count > 4 ? t + u32(tag.val) : tag.val;
    let s = "";
    for (let i = 0; i < tag.count - 1; i++) s += String.fromCharCode(v.getUint8(off + i));
    return s;
  };
  const ifd0 = readIFD(u32(t + 4));
  let d = null;
  if (ifd0[0x8769]) { const ex = readIFD(u32(ifd0[0x8769].val)); if (ex[0x9003]) d = str(ex[0x9003]); }  // 撮影日時
  if (!d && ifd0[0x0132]) d = str(ifd0[0x0132]);                                                         // 更新日時
  const m = d && /^(\d{4}):(\d{2})/.exec(d);
  return m ? m[1] + "-" + m[2] : null;
}



function button(label) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "btn"; b.textContent = label;
  return b;
}
function note(text) {
  const p = document.createElement("p"); p.className = "hint"; p.textContent = text; return p;
}
function fail(m, error, ...btns) {
  m.className = "msg err"; m.textContent = "処理できませんでした（" + error.message + "）。";
  btns.forEach((b) => (b.disabled = false));
}

/* ---------- 3. 写真から取り込む ---------- */

/* 射影変換（斜めの四角形と長方形の対応）の計算 */
function solve(A, b) {
  const n = b.length;
  A = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const v = A[c][c];
    if (Math.abs(v) < 1e-12) return null;
    for (let k = c; k <= n; k++) A[c][k] /= v;
    for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c]; if (f) for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k]; }
  }
  return A.map((r) => r[n]);
}
function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  return h ? [...h, 1] : null;
}
const applyH = (h, x, y) => { const w = h[6] * x + h[7] * y + h[8]; return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// 4つの点を「左上・右上・右下・左下」の順に並べる
function orderCorners(pts) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4, cy = pts.reduce((s, p) => s + p[1], 0) / 4;
  const s = [...pts].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let i0 = 0;
  s.forEach((p, i) => { if (p[0] + p[1] < s[i0][0] + s[i0][1]) i0 = i; });
  return [...s.slice(i0), ...s.slice(0, i0)];
}
const pxSize = (q) => [(dist(q[0], q[1]) + dist(q[3], q[2])) / 2, (dist(q[0], q[3]) + dist(q[1], q[2])) / 2];

// 斜めに写った四角形を、正面の長方形に切り抜く
function rectify(srcData, corners, outW, outH) {
  const H = homography([[0, 0], [outW, 0], [outW, outH], [0, outH]], corners);
  const out = new ImageData(outW, outH), o = out.data, s = srcData.data, W = srcData.width, Hh = srcData.height;
  for (let v = 0; v < outH; v++) for (let u = 0; u < outW; u++) {
    let [x, y] = applyH(H, u + 0.5, v + 0.5); x -= 0.5; y -= 0.5;
    const x0 = Math.max(0, Math.min(W - 1, Math.floor(x))), y0 = Math.max(0, Math.min(Hh - 1, Math.floor(y)));
    const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(Hh - 1, y0 + 1);
    const fx = Math.min(1, Math.max(0, x - x0)), fy = Math.min(1, Math.max(0, y - y0));
    const i00 = (y0 * W + x0) * 4, i10 = (y0 * W + x1) * 4, i01 = (y1 * W + x0) * 4, i11 = (y1 * W + x1) * 4, oi = (v * outW + u) * 4;
    for (let k = 0; k < 3; k++) o[oi + k] = (s[i00 + k] * (1 - fx) + s[i10 + k] * fx) * (1 - fy) + (s[i01 + k] * (1 - fx) + s[i11 + k] * fx) * fy;
    o[oi + 3] = 255;
  }
  return out;
}

// 測った寸法に最も近い規格の大きさ
function snapSize(w, h) {
  const land = w > h;
  let best = null;
  for (const [n, a, b] of STD_SIZES) {
    const W = land ? b : a, H = land ? a : b;
    const err = Math.max(Math.abs(w - W) / W, Math.abs(h - H) / H);
    if (!best || err < best.err) best = { name: n + (land ? "横" : ""), W, H, err };
  }
  return best;
}
const sizeOptions = (land) => STD_SIZES.map(([n, a, b]) => ({ label: n + (land ? "横" : ""), W: land ? b : a, H: land ? a : b }));

/* 取り込みの状態 */
const T = { photo: null, orig: null, data: null, pcv: null, quad: null, toSrc: null, wq: null,
            mode: null, cur: [], ref: null, items: [], zoom: 1, fit: 1, drag: null, seq: 0 };
const pc = $("pick-canvas"), px = pc.getContext("2d");

function setMode(m) {
  T.mode = T.mode === m ? null : m;
  T.cur = [];
  $("mode-ref").classList.toggle("on", T.mode === "ref");
  $("mode-item").classList.toggle("on", T.mode === "item");
  $("mode-warp").classList.toggle("on", T.mode === "warp");
  $("mode-crop").classList.toggle("on", T.mode === "crop");
  $("tool-hint").textContent =
    T.mode === "ref" ? "基準にするもの（寸法の分かる掲示物1枚、または掲示面）の四隅を順不同でクリックしてください。"
    : T.mode === "item" ? "取り込む掲示物の四隅を順不同でクリックしてください。続けて次の掲示物も指定できます。点はドラッグで動かせます。"
    : T.mode === "crop" ? "残したい範囲をドラッグで囲みます。指を離すと、その範囲だけに切り詰められます。"
    : T.mode === "warp" ? "写真の四隅にある白い四角をドラッグして変形します。指を離すと写真が描き直されます。もう一度「変形」を押すと終了します。"
    : "点はドラッグで動かせます。";
  draw();
}
$("mode-ref").addEventListener("click", () => setMode("ref"));
$("mode-item").addEventListener("click", () => setMode("item"));
$("mode-warp").addEventListener("click", () => setMode("warp"));
$("mode-crop").addEventListener("click", () => setMode("crop"));

// 写真を四角く切り詰める（今表示されている写真から、囲んだ範囲だけを残す）
function applyCrop(a, b) {
  const x0 = Math.max(0, Math.round(Math.min(a[0], b[0]))), y0 = Math.max(0, Math.round(Math.min(a[1], b[1])));
  const x1 = Math.min(T.data.width, Math.round(Math.max(a[0], b[0]))), y1 = Math.min(T.data.height, Math.round(Math.max(a[1], b[1])));
  const w = x1 - x0, h = y1 - y0;
  if (w < 20 || h < 20) return;   // 小さすぎる範囲は無視（クリックしただけの場合など）
  const c = document.createElement("canvas");
  c.width = T.data.width; c.height = T.data.height;
  const x = c.getContext("2d", { willReadFrequently: true });
  x.putImageData(T.data, 0, 0);
  T.orig = x.getImageData(x0, y0, w, h);
  // 指定済みの点を、切り詰めた後の位置にずらす（写真の周りの余白の分も足す）
  const m = Math.round(0.12 * Math.max(w, h));
  const shift = (p) => { p[0] += m - x0; p[1] += m - y0; };
  if (T.ref) T.ref.pts.forEach(shift);
  T.items.forEach((it) => it.pts.forEach(shift));
  T.cur.forEach(shift);
  T.quad = null; T.toSrc = null;
  warpRebuild([[0, 0], [w, 0], [w, h], [0, h]]);
  T.fit = Math.min(1, ($("pick-wrap").clientWidth || 600) / pc.width);
  T.zoom = 1;
  applyZoom();
  if (T.ref) setupRef(true); else renderItems();
  setMode("item");   // 切り詰めが終わったら、掲示物の指定に戻る
}
$("crop-reset").addEventListener("click", () => {
  if (!T.full) return;
  T.orig = T.full; T.quad = null; T.toSrc = null;
  T.ref = null; T.items = []; T.cur = []; T.seq = 0;
  warpRebuild([[0, 0], [T.orig.width, 0], [T.orig.width, T.orig.height], [0, T.orig.height]]);
  T.fit = Math.min(1, ($("pick-wrap").clientWidth || 600) / pc.width);
  T.zoom = 1;
  applyZoom();
  $("ref-fields").hidden = true;
  $("ref-state").textContent = "未指定。寸法の分かるもの（掲示物1枚、または掲示面）の四隅をクリックします。";
  renderItems();
  $("tool-msg").className = "msg"; $("tool-msg").textContent = "読み込んだ時の写真に戻しました。掲示物の指定はやり直してください。";
});

// 写真を読み込む
$("photo-file").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  // 写真に記録された撮影日から、撮影時期を入れる
  file.arrayBuffer().then((buf) => {
    const month = exifMonth(buf);
    if (month) { $("m-shot").value = month; $("m-shot-note").textContent = "写真の撮影日から入れました"; }
    else { $("m-shot-note").textContent = "撮影日が記録されていない写真です。年と月を選んでください"; }
  });
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    T.photo = img; T.ref = null; T.items = []; T.cur = []; T.seq = 0;
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(img, 0, 0);
    T.orig = x.getImageData(0, 0, c.width, c.height);
    T.full = T.orig;   // 「切り詰めを戻す」用に、読み込んだ時の写真を取っておく
    T.group = crypto.randomUUID();   // 同じ写真から取り込んだ掲示物に付ける共通の印（関連付けの線に使う）
    T.quad = null; T.toSrc = null; T.wq = null;
    warpRebuild([[0, 0], [c.width, 0], [c.width, c.height], [0, c.height]]);
    ["mode-ref", "mode-item", "mode-crop", "crop-reset", "mode-warp", "warp-reset"].forEach((id) => ($(id).disabled = false));
    T.fit = Math.min(1, ($("pick-wrap").clientWidth || 600) / pc.width);
    T.zoom = 1;
    applyZoom();
    $("ref-fields").hidden = true;
    $("ref-state").textContent = "未指定。寸法の分かるもの（掲示物1枚、または掲示面）の四隅をクリックします。";
    setMode("item");
    renderItems();
  };
  img.onerror = () => { $("tool-msg").className = "msg err"; $("tool-msg").textContent = "この画像は読み込めませんでした。JPEGかPNGで保存し直してください。"; };
  img.src = url;
});

// 写真全体の変形：写真の四隅を動かした四角形に、写真を描き直す
function warpRebuild(newQuad) {
  const o = T.orig, W0 = o.width, H0 = o.height, S = [[0, 0], [W0, 0], [W0, H0], [0, H0]];
  const xs = newQuad.map((p) => p[0]), ys = newQuad.map((p) => p[1]), m = Math.round(0.12 * Math.max(W0, H0));
  const ox = Math.floor(Math.min(...xs)) - m, oy = Math.floor(Math.min(...ys)) - m;
  const W = Math.ceil(Math.max(...xs)) - ox + m, H = Math.ceil(Math.max(...ys)) - oy + m;
  const msg = $("tool-msg");
  if (W * H > 16e6) { msg.className = "msg err"; msg.textContent = "変形が大きすぎます。四隅を内側に戻してください。"; return false; }
  const q = newQuad.map((p) => [p[0] - ox, p[1] - oy]);
  const fwd = homography(S, q), back = homography(q, S);
  if (!fwd || !back) { msg.className = "msg err"; msg.textContent = "この形には変形できません。四隅が交差しないように動かしてください。"; return false; }
  msg.textContent = "";
  // 指定済みの点も一緒に動かす
  if (T.toSrc) {
    const old = T.toSrc;
    const mv = (p) => { const n = applyH(fwd, ...applyH(old, ...p)); p[0] = n[0]; p[1] = n[1]; };
    if (T.ref) T.ref.pts.forEach(mv);
    T.items.forEach((it) => it.pts.forEach(mv));
    T.cur.forEach(mv);
  }
  T.quad = q; T.toSrc = back;
  const out = new ImageData(W, H), d = out.data, s = o.data;
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
    const oi = (v * W + u) * 4;
    let [x, y] = applyH(back, u + 0.5, v + 0.5); x -= 0.5; y -= 0.5;
    if (!(x >= 0 && y >= 0 && x <= W0 - 1 && y <= H0 - 1)) { d[oi] = d[oi + 1] = d[oi + 2] = 32; d[oi + 3] = 255; continue; }
    const x0 = x | 0, y0 = y | 0, x1 = Math.min(W0 - 1, x0 + 1), y1 = Math.min(H0 - 1, y0 + 1), fx = x - x0, fy = y - y0;
    const i00 = (y0 * W0 + x0) * 4, i10 = (y0 * W0 + x1) * 4, i01 = (y1 * W0 + x0) * 4, i11 = (y1 * W0 + x1) * 4;
    for (let c = 0; c < 3; c++) d[oi + c] = (s[i00 + c] * (1 - fx) + s[i10 + c] * fx) * (1 - fy) + (s[i01 + c] * (1 - fx) + s[i11 + c] * fx) * fy;
    d[oi + 3] = 255;
  }
  T.data = out;
  if (!T.pcv) T.pcv = document.createElement("canvas");
  T.pcv.width = W; T.pcv.height = H;
  T.pcv.getContext("2d").putImageData(out, 0, 0);
  pc.width = W; pc.height = H;
  return true;
}
$("warp-reset").addEventListener("click", () => {
  if (!T.orig) return;
  const x0 = Math.min(...T.quad.map((p) => p[0])), y0 = Math.min(...T.quad.map((p) => p[1]));
  const W0 = T.orig.width, H0 = T.orig.height;
  warpRebuild([[x0, y0], [x0 + W0, y0], [x0 + W0, y0 + H0], [x0, y0 + H0]]);
  applyZoom();
  if (T.ref) setupRef(true); else renderItems();
});

// 表示倍率
function buildZoom() {
  const seg = $("zoom-seg");
  seg.textContent = "";
  [1, 2, 4].forEach((z) => {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = z === 1 ? "全体" : z + "倍";
    b.setAttribute("aria-pressed", String(T.zoom === z));
    b.addEventListener("click", () => { T.zoom = z; applyZoom(); });
    seg.appendChild(b);
  });
}
function applyZoom() {
  if (T.photo) pc.style.width = Math.round(pc.width * T.fit * T.zoom) + "px";
  buildZoom();
  draw();
}
const cssScale = () => pc.getBoundingClientRect().width / pc.width || 1;
function evPt(e) {
  const r = pc.getBoundingClientRect(), s = pc.width / r.width;
  return [(e.clientX - r.left) * s, (e.clientY - r.top) * s];
}

// 写真と、指定した枠を描く
function draw() {
  if (!T.photo) return;
  px.drawImage(T.pcv, 0, 0);
  const lw = 2 / cssScale(), rad = 6 / cssScale();
  const poly = (pts, color, label) => {
    px.lineWidth = lw; px.strokeStyle = color;
    if (pts.length === 4) {
      const q = orderCorners(pts);
      px.beginPath(); q.forEach((p, i) => (i ? px.lineTo(...p) : px.moveTo(...p))); px.closePath(); px.stroke();
      if (label) {
        const c = [q.reduce((s, p) => s + p[0], 0) / 4, q.reduce((s, p) => s + p[1], 0) / 4];
        px.font = "700 " + 16 / cssScale() + "px sans-serif"; px.textAlign = "center"; px.textBaseline = "middle";
        px.lineWidth = 4 / cssScale(); px.strokeStyle = "#000"; px.strokeText(label, ...c);
        px.fillStyle = "#fff"; px.fillText(label, ...c);
      }
    }
    pts.forEach((p) => {
      px.beginPath(); px.arc(p[0], p[1], rad, 0, Math.PI * 2);
      px.fillStyle = color; px.fill(); px.lineWidth = lw; px.strokeStyle = "#000"; px.stroke();
    });
  };
  if (T.ref) poly(T.ref.pts, "#f2c200", "基準");
  T.items.forEach((it) => poly(it.pts, "#ffffff", String(it.n)));
  if (T.cur.length) poly(T.cur, "#ff3b3b");
  if (T.mode === "crop" && T.cropPts) {
    const [a, b] = T.cropPts;
    const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]), w = Math.abs(a[0] - b[0]), h = Math.abs(a[1] - b[1]);
    px.lineWidth = lw * 2.5; px.strokeStyle = "#000"; px.setLineDash([]); px.strokeRect(x, y, w, h);
    px.lineWidth = lw; px.strokeStyle = "#fff"; px.setLineDash([8 / cssScale(), 6 / cssScale()]); px.strokeRect(x, y, w, h);
    px.setLineDash([]);
  }
  if (T.mode === "warp" && T.quad) {
    const q = T.wq || T.quad;
    const path = () => { px.beginPath(); q.forEach((p, i) => (i ? px.lineTo(...p) : px.moveTo(...p))); px.closePath(); };
    path(); px.lineWidth = lw * 2.5; px.strokeStyle = "#000"; px.stroke();
    path(); px.lineWidth = lw; px.strokeStyle = "#fff"; px.stroke();
    const hs = 7 / cssScale();
    q.forEach((p) => {
      px.fillStyle = "#fff"; px.fillRect(p[0] - hs, p[1] - hs, hs * 2, hs * 2);
      px.strokeStyle = "#000"; px.lineWidth = lw; px.strokeRect(p[0] - hs, p[1] - hs, hs * 2, hs * 2);
    });
  }
}

// 既存の点の近くを押したか
function hitPoint(p) {
  const r = 14 / cssScale();
  const lists = [];
  if (T.ref) lists.push(["ref", T.ref.pts]);
  T.items.forEach((it) => lists.push([it, it.pts]));
  lists.push(["cur", T.cur]);
  for (const [owner, pts] of lists) for (let i = 0; i < pts.length; i++) if (dist(pts[i], p) < r) return { owner, pts, i };
  return null;
}

pc.addEventListener("pointerdown", (e) => {
  if (!T.photo) return;
  const p = evPt(e);
  if (T.mode === "crop") {
    T.cropPts = [p, [...p]];
    T.drag = { owner: "crop", pts: T.cropPts, i: 1 };
    pc.setPointerCapture(e.pointerId);
    return;
  }
  if (T.mode === "warp") {
    const r = 16 / cssScale(), i = T.quad.findIndex((q) => dist(q, p) < r);
    if (i >= 0) { T.wq = T.quad.map((q) => [...q]); T.drag = { owner: "quad", pts: T.wq, i }; pc.setPointerCapture(e.pointerId); }
    return;
  }
  // 既にある点の近くを押した場合：動かせば点の移動、動かさずに離せば新しい点の追加として扱う
  // （隣り合う掲示物の角が近いとき、新しい点が打てなくなるのを防ぐため）
  const h = hitPoint(p);
  if (h) { T.pending = { h, x: e.clientX, y: e.clientY, p }; pc.setPointerCapture(e.pointerId); return; }
  addPoint(p);
});

// 4つの点が、切り抜ける四角形になっているか（面積が十分あり、変換が計算できるか）
function validQuad(pts) {
  const q = orderCorners(pts);
  let area = 0;
  for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; area += a[0] * b[1] - b[0] * a[1]; }
  if (Math.abs(area) / 2 < 100) return false;
  const [w, h] = pxSize(q);
  return w >= 5 && h >= 5 && !!homography([[0, 0], [w, 0], [w, h], [0, h]], q);
}

function addPoint(p) {
  if (T.mode !== "ref" && T.mode !== "item") return;
  T.cur.push(p);
  if (T.cur.length === 4) {
    if (T.mode === "ref") { T.ref = { pts: T.cur }; T.cur = []; setupRef(); setMode(null); setMode("item"); }
    else if (!validQuad(T.cur)) {
      // 四隅が近すぎる・一直線に並んでいる場合は、切り抜けないので受け付けない
      T.cur = [];
      $("tool-msg").className = "msg err";
      $("tool-msg").textContent = "四隅が近すぎるか、一直線に並んでいます。その掲示物はもう一度四隅を指定してください。";
    }
    else { $("tool-msg").textContent = ""; T.items.push({ n: ++T.seq, pts: T.cur, title: "", sizeIdx: null }); T.cur = []; renderItems(); }
  }
  draw();
}
pc.addEventListener("pointermove", (e) => {
  if (T.pending && Math.hypot(e.clientX - T.pending.x, e.clientY - T.pending.y) > 4) { T.drag = T.pending.h; T.pending = null; }
  if (!T.drag) return;
  T.drag.pts[T.drag.i] = evPt(e);
  draw();
});
pc.addEventListener("pointerup", () => {
  if (T.pending) { const p = T.pending.p; T.pending = null; addPoint(p); return; }
  if (!T.drag) return;
  const o = T.drag.owner;
  T.drag = null;
  if (o === "crop") { const [a, b] = T.cropPts; T.cropPts = null; applyCrop(a, b); draw(); return; }
  if (o === "quad") { const q = T.wq; T.wq = null; warpRebuild(q); applyZoom(); if (T.ref) setupRef(true); else renderItems(); return; }
  if (o === "ref") setupRef(true); else if (o !== "cur") renderItems();
});

// 基準の大きさ
const refLand = () => { const [w, h] = pxSize(orderCorners(T.ref.pts)); return w > h; };
function setupRef(keep) {
  $("ref-fields").hidden = false;
  const sel = $("ref-size"), prev = sel.value;
  sel.textContent = "";
  sizeOptions(refLand()).forEach((o, i) => {
    const op = document.createElement("option"); op.value = String(i); op.textContent = o.label + "（" + o.W + "×" + o.H + "mm）"; sel.append(op);
  });
  const op = document.createElement("option"); op.value = "custom"; op.textContent = "実寸を入力"; sel.append(op);
  sel.value = keep && prev ? prev : String(STD_SIZES.findIndex((s) => s[0] === "A4"));
  onRefChange();
}
function refDims() {
  const v = $("ref-size").value;
  if (v === "custom") return [+$("ref-w").value || 0, +$("ref-h").value || 0];
  const o = sizeOptions(refLand())[+v];
  return [o.W, o.H];
}
function onRefChange() {
  const custom = $("ref-size").value === "custom";
  $("ref-w-label").hidden = !custom; $("ref-h-label").hidden = !custom;
  const [W, H] = refDims();
  $("ref-state").textContent = "写真上の黄色い枠を " + W + "×" + H + "mm として寸法を計算します。";
  renderItems();
}
$("ref-size").addEventListener("change", onRefChange);
$("ref-w").addEventListener("input", onRefChange);
$("ref-h").addEventListener("input", onRefChange);

// 掲示物の寸法を測る
function refH() {
  if (!T.ref) return null;
  const [W, H] = refDims();
  if (!(W > 0 && H > 0)) return null;
  return homography(orderCorners(T.ref.pts), [[0, 0], [W, 0], [W, H], [0, H]]);
}
function measure(it) {
  const q = orderCorners(it.pts), Hm = refH();
  const [pw, ph] = pxSize(q);
  if (!Hm) return { mm: null, pw, ph, q };
  return { mm: pxSize(q.map((p) => applyH(Hm, ...p))), pw, ph, q };
}
// 縦横比は、切り抜いた画像の比率（四隅の間の長さ）をそのまま使う。
// 大きさは掲示した時に掲示面の上でランダムに決まるので、実際の寸法は使わない
function chosenSize(it, ms) {
  return { label: "", W: ms.pw, H: ms.ph };
}

// 掲示物の一覧（右側）
function renderItems() {
  const box = $("items");
  box.textContent = "";
  $("item-count").textContent = T.items.length;
  $("post-all").disabled = !T.items.length;
  if (!T.items.length) { box.append(note("「掲示物を追加」を押して、掲示物の四隅をクリックします。")); draw(); return; }

  T.items.forEach((it) => {
    const ms = measure(it), sz = chosenSize(it, ms);
    const row = document.createElement("div"); row.className = "item";
    const cv = document.createElement("canvas");
    const tw = 96, th = Math.max(1, Math.round(tw * sz.H / sz.W));
    cv.width = tw; cv.height = th;
    cv.getContext("2d").putImageData(rectify(T.data, ms.q, tw, th), 0, 0);

    const col = document.createElement("div"); col.className = "col";
    const top = document.createElement("div"); top.className = "r";
    const num = document.createElement("b"); num.textContent = it.n;
    const meas = document.createElement("span");
    meas.textContent = "縦横比 " + Math.round(ms.pw) + "：" + Math.round(ms.ph);
    top.append(num, meas);

    const r2 = document.createElement("div"); r2.className = "r";
    const del = button("削除");
    del.addEventListener("click", () => { T.items = T.items.filter((x) => x !== it); renderItems(); });
    r2.append(del);
    const cr = null;
    const ti = document.createElement("input");
    ti.className = "mini"; ti.id = "ti" + it.n; ti.placeholder = "見出し（任意・拡大表示に出ます）"; ti.value = it.title;
    ti.addEventListener("input", () => { it.title = ti.value; });

    col.append(...[top, r2, cr, ti].filter(Boolean));
    row.append(cv, col);
    box.append(row);
  });
  draw();
}

/* ---------- まとめて送る ----------
   1枚ずつ切り抜いて JPEG にし、ページごとの TOOL.handler に渡す。
   TOOL.handler(blob, info) は、保存に成功したら何も返さず、失敗したら例外を投げる。 */
const TOOL = {
  verb: "掲示",            // 画面に出す動詞（管理ページ：掲示、投稿ページ：送信）
  handler: null,           // async (blob, info) => { … }
  before: async () => {},  // まとめて送る前に1回だけ呼ばれる
  after: () => {},         // まとめて送った後に1回だけ呼ばれる
};

$("post-all").addEventListener("click", async () => {
  const msg = $("tool-msg"), btn = $("post-all");
  btn.disabled = true; msg.className = "msg";
  const meta = { place: $("m-place").value.trim(), shot: monthToText($("m-shot").value), source: $("m-source").value };
  let done = 0;
  const total = T.items.length;
  const failed = [];
  try {
    await TOOL.before();
    for (const it of [...T.items]) {
      msg.textContent = TOOL.verb + "しています（" + (done + failed.length + 1) + "/" + total + "）";
      if (!validQuad(it.pts)) { failed.push(it.n + "番（四隅の指定が正しくありません）"); continue; }
      try {
        const ms = measure(it);
        let ow = Math.max(1, Math.round(ms.pw)), oh = Math.max(1, Math.round(ms.ph));
        const cap = SAVE_LONG_SIDE / Math.max(ow, oh);
        if (cap < 1) { ow = Math.round(ow * cap); oh = Math.round(oh * cap); }
        const c = document.createElement("canvas");
        c.width = ow; c.height = oh;
        c.getContext("2d").putImageData(rectify(T.data, ms.q, ow, oh), 0, 0);
        const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", SAVE_QUALITY));
        await TOOL.handler(blob, { width: ow, height: oh, title: it.title.trim(), group: T.group, ...meta });
        T.items = T.items.filter((x) => x !== it);
        done++;
      } catch (err) {
        failed.push(it.n + "番（" + (err.message || "error") + "）");
      }
    }
    if (failed.length) {
      msg.className = "msg err";
      msg.textContent = done + "枚を" + TOOL.verb + "しました。" + TOOL.verb + "できなかったもの：" + failed.join("、") + "。一覧に残っています。";
    } else msg.textContent = done + "枚を" + TOOL.verb + "しました。";
    TOOL.after();
  } catch (e) {
    msg.className = "msg err";
    msg.textContent = done + "枚を" + TOOL.verb + "したところで止まりました（" + (e.message || "error") + "）。残りは一覧に残っています。";
  } finally {
    renderItems();
    btn.disabled = !T.items.length;
  }
});
