/* =========================================================
   写真の投稿ページの動き
   切り抜いた写真を、Supabase の「submit-photo」という仕組み（Edge Function）に送る。
   そこで Google Cloud Vision による自動判定をして、通ったものだけが確認待ちになる。
   ========================================================= */

TOOL.verb = "送信";
TOOL.handler = async (blob, info) => {
  const form = new FormData();
  form.append("image", blob, "photo.jpg");
  ["width", "height", "title", "place", "shot", "source", "group"].forEach((k) => form.append(k, info[k] == null ? "" : String(info[k])));
  const { data, error } = await sb.functions.invoke("submit-photo", { body: form });
  if (error) {
    // 判定で受け付けられなかった場合などは、理由の文章が返ってくる
    let reason = error.message;
    try { const j = await error.context.json(); if (j && j.reason) reason = j.reason; } catch (e) { /* 理由が読めなければそのまま */ }
    throw new Error(reason);
  }
  if (!data || !data.ok) throw new Error((data && data.reason) || "送信できませんでした");
};
TOOL.after = () => {
  const msg = $("tool-msg");
  if (!msg.classList.contains("err")) msg.textContent += "管理者の確認後に掲示されます。";
};

drawTitle($("title"));
if (document.fonts) document.fonts.ready.then(() => drawTitle($("title")));
buildZoom();
