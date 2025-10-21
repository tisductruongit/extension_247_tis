const KEY_WEBHOOK = "TIS:discordWebhook";
const KEY_CREATOR = "TIS:creatorName";
const VALID_WEBHOOK = /^(https:\/\/(ptb\.)?discord\.com\/api\/webhooks\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+)$/;

const $ = (id) => document.getElementById(id);
const statusEl = $("status"), whEl = $("webhook"), crEl = $("creator");

function setStatus(msg, type="") {
  statusEl.className = type === "ok" ? "ok" : type === "err" ? "err" : "hint";
  statusEl.textContent = msg;
}

document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.local.get([KEY_WEBHOOK, KEY_CREATOR], (g) => {
    whEl.value = g[KEY_WEBHOOK] || "";
    crEl.value = g[KEY_CREATOR] || "";
    if (g[KEY_WEBHOOK]) setStatus("Webhook đã được cấu hình.");
  });
});

$("save").onclick = () => {
  const url = (whEl.value || "").trim();
  const creator = (crEl.value || "").trim();
  if (!url) return setStatus("Vui lòng nhập webhook URL.", "err");
  if (!VALID_WEBHOOK.test(url)) return setStatus("Webhook URL không hợp lệ.", "err");
  chrome.storage.local.set({ [KEY_WEBHOOK]: url, [KEY_CREATOR]: creator }, () => setStatus("Đã lưu cài đặt!", "ok"));
};

$("test").onclick = async () => {
  const url = (whEl.value || "").trim();
  const creator = (crEl.value || "").trim() || "TIS Tester";
  if (!VALID_WEBHOOK.test(url)) return setStatus("Webhook URL không hợp lệ.", "err");

  const payload = {
    username: "TIS 247Express Bot",
    embeds: [{
      title: creator, // tiêu đề = tên người tạo đơn
      description: "**Thông báo thử nghiệm**\nNếu bạn thấy tin nhắn này, webhook đang hoạt động.",
      color: 0xE30613,
      timestamp: new Date().toISOString()
    }]
  };

  try {
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error("Non-2xx");
    setStatus("Đã gửi test THANH CONG!", "ok");
  } catch {
    setStatus("Gửi test thất bại. Kiểm tra URL / quyền kênh.", "err");
  }
};