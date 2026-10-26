/* =========================================================
   管理ページの動き
   1. ログイン（管理者として登録されているかを確認）
   2. 申請一覧：許可して掲示 / 見送る
   3. 写真から取り込む：基準・掲示物の四隅・変形・寸法計算 → 保存して掲示
   4. 掲示中の一覧：撤去
   ========================================================= */
// $・保存の大きさ・撮影時期・ボタンなどの共通の部品は tool.js にある

/* ---------- 1. ログイン ---------- */

$("login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("login-msg");
  msg.className = "msg"; msg.textContent = "確認しています…";
  const { error } = await sb.auth.signInWithPassword({ email: $("email").value.trim(), password: $("password").value });
  if (error) { msg.className = "msg err"; msg.textContent = "ログインできませんでした（" + error.message + "）。"; }
});

$("logout").addEventListener("click", () => sb.auth.signOut());

// ログイン状態が変わったとき（Supabase の仕様で、この中では直接通信せず、少し後で処理する）
sb.auth.onAuthStateChange((_event, session) => {
  setTimeout(() => onSession(session), 0);
});

async function onSession(session) {
  if (!session) { showLogin(); return; }
  const { data } = await sb.from("admins").select("user_id").eq("user_id", session.user.id);
  if (!data || !data.length) {
    showLogin();
    $("login-msg").className = "msg err";
    $("login-msg").textContent = "このアカウントは管理者として登録されていません。説明.txt の手順で登録してください。";
    $("logout").hidden = false;
    return;
  }
  $("login").hidden = true;
  $("admin-area").hidden = false;
  $("logout").hidden = false;
  loadRequests();
  await placeMissing();
  loadPosts();
  loadRefs();
  loadPhotoRequests();
}

// 掲示物を古い順に読み込む（位置を決めるときに使う）
async function fetchPostsOrdered() {
  const { data, error } = await sb.from("posts").select("*").order("posted_at", { ascending: true });
  if (error) throw error;
  return data;
}

// 位置がまだ決まっていない掲示物があれば、位置を決めて保存する
async function placeMissing() {
  let list;
  try { list = await fetchPostsOrdered(); } catch (e) { return; }
  for (let i = 0; i < list.length; i++) {
    if (list[i].pos_width != null) continue;
    const pos = choosePosition(list, i);
    Object.assign(list[i], pos);
    await sb.from("posts").update(pos).eq("id", list[i].id);
  }
}

function showLogin() {
  $("login").hidden = false;
  $("admin-area").hidden = true;
  $("logout").hidden = true;
}


/* ---------- 2. 申請一覧 ---------- */

async function loadRequests() {
  const box = $("requests");
  box.textContent = "";
  const { data, error } = await sb.from("requests").select("*").eq("status", "pending").order("created_at");
  if (error) { box.append(note("読み込めませんでした（" + error.message + "）")); return; }
  if (!data.length) { box.append(note("確認待ちの申請はありません。")); return; }

  data.forEach((req) => {
    const row = document.createElement("div");
    row.className = "list-item";
    const img = drawTextFlyer(req, 220);
    const cv = document.createElement("canvas");
    cv.width = img.width; cv.height = img.height;
    cv.getContext("2d").putImageData(img, 0, 0);

    const info = document.createElement("div");
    info.className = "info";
    const when = document.createElement("span");
    when.textContent = "申請日 " + fmtDate(req.created_at);
    const ops = document.createElement("div");
    ops.className = "ops";
    const ok = button("許可して掲示"), ng = button("見送る");
    const m = document.createElement("p"); m.className = "msg";

    ok.addEventListener("click", async () => {
      ok.disabled = ng.disabled = true;
      const [w, h] = TEXT_SIZES[req.size] || TEXT_SIZES.A4;
      let list;
      try { list = await fetchPostsOrdered(); } catch (err) { fail(m, err, ok, ng); return; }
      const np = { width_mm: w, height_mm: h };
      list.push(np);
      const ins = await sb.from("posts").insert({
        kind: "text", title: req.title, body: req.body, name: req.name, paper: req.paper, ink: req.ink,
        width_mm: w, height_mm: h, size_label: req.size,
        ...choosePosition(list, list.length - 1),   // 大きさと位置はこの時に1回だけ決まる
      });
      if (ins.error) { fail(m, ins.error, ok, ng); return; }
      const upd = await sb.from("requests").update({ status: "approved" }).eq("id", req.id);
      if (upd.error) { fail(m, upd.error, ok, ng); return; }
      loadRequests(); loadPosts();
    });
    ng.addEventListener("click", async () => {
      ok.disabled = ng.disabled = true;
      const upd = await sb.from("requests").update({ status: "rejected" }).eq("id", req.id);
      if (upd.error) { fail(m, upd.error, ok, ng); return; }
      loadRequests();
    });

    ops.append(ok, ng);
    info.append(when, ops, m);
    row.append(cv, info);
    box.append(row);
  });
}

$("reload-requests").addEventListener("click", loadRequests);


/* ---------- 4. 掲示中の一覧 ---------- */

let linkFrom = null;   // 「つなぐ」を押した1枚目の掲示物

async function loadPosts() {
  loadHistory();   // 掲示物が変わったときに、時系列の表示も作り直す
  const box = $("posts");
  box.textContent = "";
  const { data, error } = await sb.from("posts").select("*").order("posted_at", { ascending: false });
  if (error) { box.append(note("読み込めませんでした（" + error.message + "）")); return; }
  if (!data.length) { box.append(note("掲示中の掲示物はありません。")); return; }

  // 手動でつないだ組を読み込む
  const lres = await sb.from("links").select("*");
  const links = lres.error ? [] : lres.data;
  // 掲示物ごとのリンク（関連する情報の URL）
  const [rr, rp] = await Promise.all([sb.from("refs").select("*"), sb.from("ref_posts").select("*")]);
  const refs = rr.error ? [] : rr.data, refPosts = rp.error ? [] : rp.data;
  const titleOf = {};
  data.forEach((p) => { titleOf[p.id] = (p.title || "（見出しなし）") + "（" + fmtDate(p.posted_at) + "）"; });
  if (lres.error) box.append(note("関連付けを読み込めませんでした。update2.sql を実行したか確認してください。"));
  if (linkFrom) {
    const n = note("つなぐ相手の「この掲示物とつなぐ」を押してください。やめるときは「つなぐのをやめる」。");
    n.className = "msg";
    box.append(n);
  }

  data.forEach((post) => {
    const row = document.createElement("div");
    row.className = "list-item";
    const cv = document.createElement("canvas");
    drawFaded(cv, post, 300).catch(() => {});
    const info = document.createElement("div");
    info.className = "info";
    const t = document.createElement("span");
    t.textContent = (post.title || "（見出しなし）") + "　掲示日 " + fmtDate(post.posted_at) + (post.size_label ? "　" + post.size_label : "");
    const ops = document.createElement("div"); ops.className = "ops";
    const m = document.createElement("p"); m.className = "msg";

    // 撤去
    const rm = button("撤去する");
    rm.addEventListener("click", async () => {
      if (!rm.dataset.armed) { rm.dataset.armed = "1"; rm.textContent = "もう一度押すと撤去します"; return; }
      rm.disabled = true;
      const del = await sb.from("posts").delete().eq("id", post.id);
      if (del.error) { fail(m, del.error, rm); return; }
      if (post.image_path) await sb.storage.from(BUCKET).remove([post.image_path]);
      loadPosts();
    });

    // 位置を決め直す（大きさと位置をもう一度ランダムに決める）
    const mv = button("位置を決め直す");
    mv.addEventListener("click", async () => {
      mv.disabled = true;
      try {
        const list = await fetchPostsOrdered();
        const idx = list.findIndex((p) => p.id === post.id);
        const upd = await sb.from("posts").update(choosePosition(list, idx)).eq("id", post.id);
        if (upd.error) throw upd.error;
        m.className = "msg"; m.textContent = "位置を決め直しました。";
      } catch (e) { fail(m, e); }
      mv.disabled = false;
    });

    ops.append(mv);

    // 関連付け（手動）：1枚目で「つなぐ」→ 2枚目で「この掲示物とつなぐ」
    const ln = button(linkFrom === post.id ? "つなぐのをやめる" : linkFrom ? "この掲示物とつなぐ" : "つなぐ");
    ln.addEventListener("click", async () => {
      if (!linkFrom) { linkFrom = post.id; loadPosts(); return; }
      if (linkFrom === post.id) { linkFrom = null; loadPosts(); return; }
      const [a, b] = [linkFrom, post.id].sort();   // 同じ組を二重に作らないよう、順番を揃える
      linkFrom = null;
      const ins = await sb.from("links").insert({ a, b });
      if (ins.error && !/duplicate|unique/i.test(ins.error.message)) { fail(m, ins.error); return; }
      loadPosts();
    });
    ops.append(ln);
    // 写真から取り込んだ掲示物だけ、内容を直せる
    let form = null;
    if (post.kind === "photo") {
      const ed = button("内容を直す");
      ed.addEventListener("click", () => { form.hidden = !form.hidden; });
      ops.append(ed);
      form = editForm(post, m);
      form.hidden = true;
    }
    ops.append(rm);
    // この掲示物とつながっているもの
    const mine = links.filter((l) => l.a === post.id || l.b === post.id);
    let linked = null;
    if (mine.length) {
      linked = document.createElement("div");
      linked.className = "ops";
      const lab = document.createElement("span"); lab.textContent = "つながっている：";
      linked.append(lab);
      mine.forEach((l) => {
        const other = l.a === post.id ? l.b : l.a;
        const sp = document.createElement("span"); sp.textContent = titleOf[other] || "（不明）";
        const un = button("外す");
        un.addEventListener("click", async () => {
          const del = await sb.from("links").delete().eq("id", l.id);
          if (del.error) { fail(m, del.error); return; }
          loadPosts();
        });
        linked.append(sp, un);
      });
    }
    // この掲示物のリンク：URL を入れて「リンクを追加」。掲示板では、この掲示物の近くに URL の札が置かれ、白い線で結ばれる
    const linkBox = document.createElement("div");
    linkBox.className = "ops";
    const myRefs = refs.filter((r) => refPosts.some((x) => x.ref_id === r.id && x.post_id === post.id));
    myRefs.forEach((r) => {
      const a = document.createElement("a");
      a.href = r.url; a.target = "_blank"; a.rel = "noopener noreferrer"; a.style.color = "inherit";
      a.textContent = r.label || r.url;
      const un = button("リンクを外す");
      un.addEventListener("click", async () => {
        await sb.from("ref_posts").delete().eq("ref_id", r.id).eq("post_id", post.id);
        // ほかの掲示物とつながっていない札は、札ごと消す
        const rest = refPosts.filter((x) => x.ref_id === r.id && x.post_id !== post.id);
        if (!rest.length) await sb.from("refs").delete().eq("id", r.id);
        loadPosts(); loadRefs();
      });
      linkBox.append(a, un);
    });
    const urlIn = document.createElement("input");
    urlIn.className = "mini"; urlIn.type = "url"; urlIn.placeholder = "https://（この掲示物に関する情報のURL）";
    urlIn.id = "lk-" + post.id; urlIn.setAttribute("aria-label", "リンクのURL"); urlIn.style.maxWidth = "320px";
    const labIn = document.createElement("input");
    labIn.className = "mini"; labIn.placeholder = "表示する文字（任意）"; labIn.id = "lkl-" + post.id;
    labIn.setAttribute("aria-label", "リンクの表示する文字"); labIn.style.maxWidth = "200px";
    const add = button("リンクを追加");
    add.addEventListener("click", async () => {
      const url = urlIn.value.trim();
      if (!/^https?:\/\//.test(url)) { m.className = "msg err"; m.textContent = "URL は http:// か https:// で始まる形で入れてください。"; return; }
      add.disabled = true;
      // 同じ URL の札がすでにあれば、それにつなぐ。なければ、この掲示物の近くに新しく置く
      let ref = refs.find((r) => r.url === url);
      if (!ref) {
        const ins = await sb.from("refs").insert({ url, label: labIn.value.trim() || null, ...refPosNear(post) }).select().single();
        if (ins.error) { add.disabled = false; fail(m, ins.error); return; }
        ref = ins.data;
      }
      const lk = await sb.from("ref_posts").insert({ ref_id: ref.id, post_id: post.id });
      add.disabled = false;
      if (lk.error && !/duplicate|unique/i.test(lk.error.message)) { fail(m, lk.error); return; }
      loadPosts(); loadRefs();
    });
    const linkAdd = document.createElement("div");
    linkAdd.className = "ops";
    linkAdd.append(urlIn, labIn, add);

    info.append(...[t, ops, linked, myRefs.length ? linkBox : null, linkAdd, form, m].filter(Boolean));
    row.append(cv, info);
    box.append(row);
  });
}

// 写真の掲示物の編集欄：見出し・撮影場所・撮影時期・出典
function editForm(post, m) {
  const f = document.createElement("div");
  f.className = "edit";
  const field = (label, value, id) => {
    const l = document.createElement("label"); l.className = "field"; l.htmlFor = id; l.textContent = label;
    const i = document.createElement("input"); i.className = "mini"; i.id = id; i.value = value || "";
    l.append(i); f.append(l); return i;
  };
  const title = field("見出し", post.title, "e-title-" + post.id);
  const place = field("撮影場所", post.place, "e-place-" + post.id);
  const shot = field("撮影時期", "", "e-shot-" + post.id);
  shot.type = "month";
  shot.value = textToMonth(post.shot);

  const srcL = document.createElement("label"); srcL.className = "field"; srcL.textContent = "出典";
  const src = document.createElement("select"); src.className = "mini"; src.id = "e-src-" + post.id; srcL.htmlFor = src.id;
  ["ストリートビュー", "自分で撮影", "その他"].forEach((v) => { const o = document.createElement("option"); o.textContent = v; src.append(o); });
  if (post.source) src.value = post.source;
  srcL.append(src); f.append(srcL);

  const save = button("保存する");
  save.addEventListener("click", async () => {
    save.disabled = true;
    const upd = await sb.from("posts").update({
      title: title.value.trim(), place: place.value.trim(), shot: monthToText(shot.value), source: src.value,
    }).eq("id", post.id);
    save.disabled = false;
    if (upd.error) { fail(m, upd.error); return; }
    loadPosts();
  });
  f.append(save);
  return f;
}
$("reload-posts").addEventListener("click", loadPosts);


/* ---------- 掲示板ごとの時系列 ----------
   撮影場所（place）が同じものを1つの掲示板とみなし、撮影時期（shot）の古い順に並べる。
   同じ時期の中は、同じ写真から取り込んだもの（photo_group）ごとにまとめる。管理ページでだけ見られる */
let HISTORY = [];

// 「2019年7月」→ 201907（並べ替え用）。読めないものは一番後ろ
function shotKey(text) {
  const m = /(\d{4})\s*年\s*(\d{1,2})?/.exec(text || "");
  return m ? Number(m[1]) * 100 + Number(m[2] || 0) : 999999;
}
// 撮影場所の比べ方：前後と途中の空白の違いは無視する
const placeKey = (p) => (p.place || "").replace(/\s+/g, "");

async function loadHistory() {
  const sel = $("h-place");
  const before = sel.value;
  const { data, error } = await sb.from("posts").select("*").order("posted_at", { ascending: true });
  if (error) { $("history").textContent = "読み込めませんでした（" + error.message + "）"; return; }
  HISTORY = data;
  // 掲示板の一覧（掲示物の多い順）
  const count = {}, label = {};
  data.forEach((p) => { const k = placeKey(p); count[k] = (count[k] || 0) + 1; if (!(k in label)) label[k] = p.place || ""; });
  const keys = Object.keys(count).sort((a, b) => (a === "") - (b === "") || count[b] - count[a]);
  sel.textContent = "";
  keys.forEach((k) => {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = (k ? label[k] : "（撮影場所なし）") + "（" + count[k] + "枚）";
    sel.append(o);
  });
  if (keys.includes(before)) sel.value = before;
  showHistory();
}

function showHistory() {
  const box = $("history");
  box.textContent = "";
  const k = $("h-place").value;
  const list = HISTORY.filter((p) => placeKey(p) === k);
  if (!list.length) { box.append(note("掲示物がありません。")); return; }
  // 撮影時期ごとに分ける
  const byShot = {};
  list.forEach((p) => { const s = p.shot || ""; (byShot[s] = byShot[s] || []).push(p); });
  Object.keys(byShot).sort((a, b) => shotKey(a) - shotKey(b) || a.localeCompare(b)).forEach((shot) => {
    const sec = document.createElement("div");
    sec.className = "h-period";
    const h = document.createElement("h3");
    h.textContent = (shot || "撮影時期なし") + "　" + byShot[shot].length + "枚";
    sec.append(h);
    // 同じ写真から取り込んだものごとにまとめる
    const byPhoto = {};
    byShot[shot].forEach((p) => { const g = p.photo_group || "single:" + p.id; (byPhoto[g] = byPhoto[g] || []).push(p); });
    Object.values(byPhoto).forEach((group) => {
      const row = document.createElement("div");
      row.className = "h-photo";
      group.forEach((p) => {
        const fig = document.createElement("figure");
        const cv = document.createElement("canvas");
        getSource(p, 400).then((src) => {
          cv.width = src.width; cv.height = src.height;
          const ctx = cv.getContext("2d");
          if (src instanceof ImageData) ctx.putImageData(src, 0, 0); else ctx.drawImage(src, 0, 0);
        }).catch(() => {});
        if (p.kind === "photo" && p.image_path) {
          cv.style.cursor = "pointer";
          cv.title = "元の画像を別のタブで開く";
          cv.addEventListener("click", () => window.open(imageUrl(p.image_path), "_blank", "noopener"));
        }
        const cap = document.createElement("figcaption");
        cap.textContent = (p.title || "（見出しなし）") + "\n掲示日 " + fmtDate(p.posted_at);
        fig.append(cv, cap);
        row.append(fig);
      });
      sec.append(row);
    });
    box.append(sec);
  });
}

$("h-place").addEventListener("change", showHistory);
$("reload-history").addEventListener("click", loadHistory);

// すべての掲示物の大きさと位置を、古い順に決め直す（掲示面の大きさを変えた後などに使う）
$("replace-all").addEventListener("click", async () => {
  const btn = $("replace-all"), msg = $("replace-msg");
  if (!btn.dataset.armed) { btn.dataset.armed = "1"; btn.textContent = "もう一度押すと全部決め直します"; return; }
  btn.dataset.armed = ""; btn.textContent = "すべての位置を決め直す"; btn.disabled = true;
  try {
    const list = await fetchPostsOrdered();
    list.forEach((p) => { p.pos_left = p.pos_top = p.pos_width = null; });
    for (let i = 0; i < list.length; i++) {
      msg.className = "msg"; msg.textContent = "決め直しています（" + (i + 1) + "/" + list.length + "）";
      const pos = choosePosition(list, i);
      Object.assign(list[i], pos);
      const upd = await sb.from("posts").update(pos).eq("id", list[i].id);
      if (upd.error) throw upd.error;
    }
    msg.textContent = list.length + "枚の位置を決め直しました。";
  } catch (e) { msg.className = "msg err"; msg.textContent = "途中で止まりました（" + (e.message || "error") + "）。"; }
  btn.disabled = false;
});


/* ---------- 5. 関連する情報（URL） ---------- */

const randomRefPos = () => ({ pos_left: 0.02 + Math.random() * 0.7, pos_top: 0.03 + Math.random() * 0.9 });

$("r-add").addEventListener("click", async () => {
  const msg = $("r-msg");
  const url = $("r-url").value.trim();
  if (!/^https?:\/\//.test(url)) { msg.className = "msg err"; msg.textContent = "URL は http:// か https:// で始まる形で入れてください。"; return; }
  const ins = await sb.from("refs").insert({ url, label: $("r-label").value.trim() || null, ...randomRefPos() });
  if (ins.error) { msg.className = "msg err"; msg.textContent = "追加できませんでした（" + ins.error.message + "）。update3.sql を実行したか確認してください。"; return; }
  msg.className = "msg"; msg.textContent = "追加しました。下の一覧で、つなぐ掲示物にチェックを入れてください。";
  $("r-url").value = ""; $("r-label").value = "";
  loadRefs();
});
$("reload-refs").addEventListener("click", () => loadRefs());

async function loadRefs() {
  const box = $("refs");
  box.textContent = "";
  const [r1, r2, r3] = await Promise.all([
    sb.from("refs").select("*").order("created_at", { ascending: false }),
    sb.from("ref_posts").select("*"),
    sb.from("posts").select("*").order("posted_at", { ascending: false }),
  ]);
  if (r1.error || r2.error) { box.append(note("読み込めませんでした。update3.sql を実行したか確認してください。")); return; }
  if (!r1.data.length) { box.append(note("まだありません。")); return; }
  const posts = r3.data || [];

  r1.data.forEach((ref) => {
    const row = document.createElement("div");
    row.className = "list-item";
    const info = document.createElement("div");
    info.className = "info";
    const a = document.createElement("a");
    a.href = ref.url; a.target = "_blank"; a.rel = "noopener noreferrer"; a.style.color = "inherit";
    a.textContent = (ref.label ? ref.label + "　" : "") + ref.url;
    const m = document.createElement("p"); m.className = "msg";

    // つなぐ掲示物：チェックを入れる・外すと、その場で保存される
    const pick = document.createElement("div");
    pick.className = "ref-posts";
    const linked = new Set(r2.data.filter((x) => x.ref_id === ref.id).map((x) => x.post_id));
    posts.forEach((p) => {
      const lab = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = linked.has(p.id); cb.id = "rp-" + ref.id + "-" + p.id;
      lab.htmlFor = cb.id;
      const cv = document.createElement("canvas");
      drawFaded(cv, p, 120).catch(() => {});
      const t = document.createElement("span"); t.textContent = (p.title || "") + "（" + fmtDate(p.posted_at) + "）";
      cb.addEventListener("change", async () => {
        const res = cb.checked
          ? await sb.from("ref_posts").insert({ ref_id: ref.id, post_id: p.id })
          : await sb.from("ref_posts").delete().eq("ref_id", ref.id).eq("post_id", p.id);
        if (res.error) { cb.checked = !cb.checked; fail(m, res.error); }
      });
      lab.append(cb, cv, t);
      pick.append(lab);
    });

    const ops = document.createElement("div"); ops.className = "ops";
    const mv = button("位置を決め直す");
    mv.addEventListener("click", async () => {
      const upd = await sb.from("refs").update(randomRefPos()).eq("id", ref.id);
      if (upd.error) { fail(m, upd.error); return; }
      m.className = "msg"; m.textContent = "位置を決め直しました。";
    });
    const rm = button("削除する");
    rm.addEventListener("click", async () => {
      if (!rm.dataset.armed) { rm.dataset.armed = "1"; rm.textContent = "もう一度押すと削除します"; return; }
      const del = await sb.from("refs").delete().eq("id", ref.id);
      if (del.error) { fail(m, del.error, rm); return; }
      loadRefs();
    });
    ops.append(mv, rm);
    const head = document.createElement("span"); head.textContent = "つなぐ掲示物：";
    info.append(a, ops, head, pick, m);
    row.append(info);
    box.append(row);
  });
}



/* ---------- 6. 写真の投稿（一般の人から。自動判定を通ったもの） ---------- */
async function loadPhotoRequests() {
  const box = $("photo-requests");
  box.textContent = "";
  const { data, error } = await sb.from("photo_requests").select("*").eq("status", "pending").order("created_at");
  if (error) { box.append(note("読み込めませんでした。update4.sql を実行したか確認してください。")); return; }
  if (!data.length) { box.append(note("確認待ちの写真はありません。")); return; }

  data.forEach((req) => {
    const row = document.createElement("div");
    row.className = "list-item";
    // 非公開の場所にある画像は、管理者だけが1時間有効の一時的なアドレスで見られる
    const img = document.createElement("img");
    img.alt = "投稿された写真";
    sb.storage.from("pending").createSignedUrl(req.image_path, 3600).then(({ data: d }) => { if (d) img.src = d.signedUrl; });
    const info = document.createElement("div");
    info.className = "info";
    const t = document.createElement("span");
    t.textContent = "投稿日 " + fmtDate(req.created_at) + [req.title, req.place, req.shot, req.source].filter(Boolean).map((x) => "　" + x).join("");
    const ops = document.createElement("div"); ops.className = "ops";
    const ok = button("許可して掲示"), ng = button("見送る");
    const m = document.createElement("p"); m.className = "msg";

    ok.addEventListener("click", async () => {
      ok.disabled = ng.disabled = true;
      try {
        // 非公開の場所から取り出して、公開の場所に移す
        const dl = await sb.storage.from("pending").download(req.image_path);
        if (dl.error) throw dl.error;
        const path = "photos/" + crypto.randomUUID() + ".jpg";
        const up = await sb.storage.from(BUCKET).upload(path, dl.data, { contentType: "image/jpeg" });
        if (up.error) throw up.error;
        const list = await fetchPostsOrdered();
        const np = { width_mm: req.width_px, height_mm: req.height_px };
        list.push(np);
        Object.assign(np, choosePosition(list, list.length - 1));   // 大きさと位置はこの時に1回だけ決まる
        const ins = await sb.from("posts").insert({
          kind: "photo", image_path: path, ...np, size_label: null, photo_group: req.photo_group,
          title: req.title, place: req.place, shot: req.shot, source: req.source,
        });
        if (ins.error) { await sb.storage.from(BUCKET).remove([path]); throw ins.error; }
        await sb.storage.from("pending").remove([req.image_path]);
        await sb.from("photo_requests").update({ status: "approved" }).eq("id", req.id);
        loadPhotoRequests(); loadPosts();
      } catch (e) { fail(m, e, ok, ng); }
    });
    ng.addEventListener("click", async () => {
      ok.disabled = ng.disabled = true;
      await sb.storage.from("pending").remove([req.image_path]);
      const upd = await sb.from("photo_requests").update({ status: "rejected" }).eq("id", req.id);
      if (upd.error) { fail(m, upd.error, ok, ng); return; }
      loadPhotoRequests();
    });
    ops.append(ok, ng);
    info.append(t, ops, m);
    row.append(img, info);
    box.append(row);
  });
}
$("reload-photo-requests").addEventListener("click", loadPhotoRequests);


/* ---------- 3. 写真から取り込む（管理者：判定なしで、そのまま掲示する） ---------- */
let placeList = [];
TOOL.verb = "掲示";
TOOL.before = async () => { placeList = await fetchPostsOrdered(); };   // 位置を決めるために、今の掲示物を読み込む
TOOL.handler = async (blob, info) => {
  const path = "photos/" + crypto.randomUUID() + ".jpg";
  const up = await sb.storage.from(BUCKET).upload(path, blob, { contentType: "image/jpeg" });
  if (up.error) throw up.error;
  const np = { width_mm: info.width, height_mm: info.height };   // 縦横比として、画像の幅と高さ（px）を入れる
  placeList.push(np);
  Object.assign(np, choosePosition(placeList, placeList.length - 1));   // 大きさと位置はこの時に1回だけ決まる
  const ins = await sb.from("posts").insert({
    kind: "photo", image_path: path, ...np, size_label: null, photo_group: info.group,
    title: info.title, place: info.place, shot: info.shot, source: info.source,
  });
  if (ins.error) { placeList.pop(); await sb.storage.from(BUCKET).remove([path]); throw ins.error; }
};
TOOL.after = () => loadPosts();


/* ---------- はじめに実行 ---------- */
drawTitle($("title"));
if (document.fonts) document.fonts.ready.then(() => drawTitle($("title")));
buildZoom();
