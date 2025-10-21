(function () {
  /* ===================== CONFIG ===================== */
  const ONE_DAY_MS  = 24 * 60 * 60 * 1000;
  const FIFTEEN_MIN = 15 * 60 * 1000;

  const KEY_WEBHOOK = "TIS:discordWebhook";
  const KEY_CREATOR = "TIS:creatorName";

  const ORDER_CODE_RE = /\b[A-Z]{3,}\d{6,}\b/;
  const SUCCESS_RE = /(tạo|đặt)\s*đơn(\s*hàng)?\s*thành\s*công/i;
  const BAD_ADDR_PAT = /(giấy chứng nhận|sở kế hoạch|đầu tư|cấp ngày)/i; // lọc text pháp lý

  const LOGO_GITHUB = "https://raw.githubusercontent.com/tisductruongit/extension_TIS/refs/heads/main/logo.ico";
  const LOGO_EXT = (typeof chrome !== "undefined" && chrome.runtime?.getURL) ? chrome.runtime.getURL("icon.png") : "";
  const LOGO_DATAURL = "data:image/svg+xml;utf8," + encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="50%" y="55%" font-size="42" font-weight="700" text-anchor="middle"
        fill="#E30613" font-family="Arial, Helvetica, sans-serif">TIS</text>
</svg>`);

  /* ===================== HELPERS ===================== */
  const $ = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => root.querySelectorAll(sel);

  function saveToLocal(obj) { return new Promise(r => chrome.storage.local.set(obj, r)); }
  function getFromLocal(keys) { return new Promise(r => chrome.storage.local.get(keys, r)); }
  function removeNode(sel) { const el = $(sel); if (el) el.remove(); }
  function digitsOnly(s) { return (s || "").replace(/\D/g, ""); }
  function pickFirst(...vals){ for (const v of vals){ if (v==null) continue; const s=String(v).trim(); if (s) return s; } return ""; }
  function splitLines(text){ return (text || "").split("\n").map(s=>s.trim()).filter(Boolean); }

  function createLogo(onLoaded) {
    const img = document.createElement("img");
    img.alt = "Logo"; img.referrerPolicy = "no-referrer";
    Object.assign(img.style,{width:"60px",height:"60px",objectFit:"contain",flexShrink:"0",marginRight:"12px",marginTop:"2px"});
    const sources = [LOGO_GITHUB, LOGO_EXT, LOGO_DATAURL].filter(Boolean);
    let i=0, done=false;
    const next=()=>{ if(!done){ if(i>=sources.length){ done=true; onLoaded&&onLoaded(); } else { img.src = sources[i++]; }}};
    img.onload=()=>{ if(!done){ done=true; onLoaded&&onLoaded(); }};
    img.onerror=next; next(); return img;
  }

  async function getWebhookUrl(){ const g = await getFromLocal(KEY_WEBHOOK); return g[KEY_WEBHOOK] || ""; }
  async function getCreatorName(){ const g = await getFromLocal(KEY_CREATOR); return (g[KEY_CREATOR] || "").trim(); }

  /* ===================== ROUTER ===================== */
  const path = location.pathname || "";
  if (/\/khach-hang\/(tao-don-hang|dat-don-hang|don-hang)/.test(path)) onCreatePage();
  if (path.includes("/khach-hang/in-don-hang")) onPrintPage();

  /* ===================== CREATE PAGE ===================== */
  function onCreatePage() {
    // --- START: Tự động tải lại 1 lần khi chuyển từ trang "Đơn hàng" ---
    if (document.referrer.includes("/khach-hang/don-hang")) {
        // Dùng sessionStorage để đảm bảo chỉ reload 1 lần, tránh vòng lặp
        if (!sessionStorage.getItem('TIS_reloaded_from_don_hang')) {
            sessionStorage.setItem('TIS_reloaded_from_don_hang', 'true');
            location.reload();
            return; // Dừng thực thi script cho đến khi trang được tải lại
        }
    } else {
        // Nếu người dùng đến từ trang khác, xóa cờ đi để lần sau hoạt động đúng
        sessionStorage.removeItem('TIS_reloaded_from_don_hang');
    }
    // --- END: Tự động tải lại 1 lần khi chuyển từ trang "Đơn hàng" ---

    // --- START: LOGIC TỰ ĐỘNG TẢI LẠI TRANG (sau khi gửi Discord) ---
    const reloadState = sessionStorage.getItem('TIS_AUTO_RELOAD');
    if (reloadState === 'first') {
      sessionStorage.setItem('TIS_AUTO_RELOAD', 'second');
      setTimeout(() => window.location.reload(), 1000);
    } else if (reloadState === 'second') {
      sessionStorage.removeItem('TIS_AUTO_RELOAD');
    }
    // --- END: LOGIC TỰ ĐỘNG TẢI LẠI TRANG ---
      
    cleanupOldCache();
    ensureLottieIcon(); // <<<<<<<<<< THAY ĐỔI TẠI ĐÂY
    hookCreateOrderNetwork();      // intercept fetch/xhr
    observeDraftInputs();          // lưu nháp tên/địa chỉ
    observePhoneInputs();          // lưu nháp SĐT
  }

  function watchSuccessAny() {
    const tryHandleRoot = async (root) => {
      const full = root.innerText || "";
      if (!SUCCESS_RE.test(full) && !/Chúc mừng bạn/i.test(full)) return;

      let code = null;
      const link = root.querySelector('a[href*="/khach-hang"]');
      if (link && ORDER_CODE_RE.test(link.textContent)) code = link.textContent.match(ORDER_CODE_RE)[0];
      if (!code) { const m = full.match(ORDER_CODE_RE); if (m) code = m[0]; }
      if (!code) return;

      await captureAndNotify(code);
    };

    $$([
      '[role="dialog"]','.ant-modal, .ant-modal-root','.ant-message, .ant-notification',
      '.swal2-popup','.Toastify__toast','.v-toast, .toast, .notification'
    ].join(',')).forEach(tryHandleRoot);

    new MutationObserver((muts) => {
      muts.forEach(m => m.addedNodes.forEach(n => {
        if (!(n instanceof Element)) return;
        const root = n.matches?.('[role="dialog"], .ant-modal, .ant-modal-root, .ant-message, .ant-notification, .swal2-popup, .Toastify__toast, .v-toast, .toast, .notification')
          ? n
          : n.querySelector?.('[role="dialog"], .ant-modal, .ant-modal-root, .ant-message, .ant-notification, .swal2-popup, .Toastify__toast, .v-toast, .toast, .notification');
        if (root) tryHandleRoot(root);
      }));
    }).observe(document.documentElement, { childList:true, subtree:true });
  }

  // ===== Merge Receiver từ full JSON (receiver/to ONLY) + fallback
  function mergeReceiverFromFullJson(full, fallback = {}) {
    const norm = (s) => (String(s || "").trim().replace(/\s+/g, " ").toLowerCase());

    if (!full) {
      return {
        name: (fallback.name || "").trim(),
        phone: digitsOnly(fallback.phone || ""),
        address: (fallback.address || "").trim(),
      };
    }

    // ===== Receiver/to =====
    const rx = {
      name: pickFirst(
        full.receiverName, full.receiverFullName, full.toName,
        full.receiver, full.contactName, full.representativeName,
        full.receiverInfo?.name, full.to?.name, 
        full.to?.fullName, full.receiverContactName // thêm field dự phòng
      ),
      phone: pickFirst(
        full.receiverPhone, full.toPhone, full.receiverMobile, full.contactPhone,
        full.receiverInfo?.phone, full.to?.phone
      ),
      addrDetail: pickFirst(
        full.receiverAddress, full.toAddress, full.receiverDetailAddress, full.toDetailAddress,
        full.receiverInfo?.address, full.to?.address
      ),
      ward: pickFirst(full.receiverWardName, full.toWardName, full.receiverWard, full.toWard,
                      full.receiverInfo?.wardName, full.to?.wardName),
      dist: pickFirst(full.receiverDistrictName, full.toDistrictName, full.receiverDistrict, full.toDistrict,
                      full.receiverInfo?.districtName, full.to?.districtName),
      prov: pickFirst(full.receiverProvinceName, full.toProvinceName, full.receiverProvince, full.toProvince,
                      full.receiverInfo?.provinceName, full.to?.provinceName),
      company: pickFirst(full.receiverCompanyName, full.toCompanyName, full.receiverInfo?.companyName, full.to?.companyName),
    };

    // ===== Sender/from =====
    const sx = {
      addrDetail: pickFirst(full.senderAddress, full.fromAddress, full.senderDetailAddress, full.fromDetailAddress,
                            full.senderInfo?.address, full.from?.address),
      ward: pickFirst(full.senderWardName, full.fromWardName, full.senderWard, full.fromWard,
                      full.senderInfo?.wardName, full.from?.wardName),
      dist: pickFirst(full.senderDistrictName, full.fromDistrictName, full.senderDistrict, full.fromDistrict,
                      full.senderInfo?.districtName, full.from?.districtName),
      prov: pickFirst(full.senderProvinceName, full.fromProvinceName, full.senderProvince, full.fromProvince,
                      full.senderInfo?.provinceName, full.from?.provinceName),
    };

    // ===== Build địa chỉ =====
    const buildAddr = (detail, ward, dist, prov) => {
      const admin = [ward, dist, prov].filter(Boolean).join(", ");
      return (detail ? detail.toString().trim() : "")
            + (admin ? (detail ? ", " : "") + admin : "");
    };

    let rAddr = buildAddr(rx.addrDetail, rx.ward, rx.dist, rx.prov);
    const sAddr = buildAddr(sx.addrDetail, sx.ward, sx.dist, sx.prov);

    // ===== Ưu tiên receiver, không xoá nếu có tên/phone =====
    if (rAddr && sAddr && norm(rAddr) === norm(sAddr) && !rx.name && !rx.phone) {
      rAddr = "";
    }

    const name    = (rx.name || rx.company || fallback.name || "").trim();
    const phone   = digitsOnly(rx.phone || fallback.phone || "");
    const address = (rAddr || fallback.address || "").trim();

    return { name, phone, address };
  }


  // ===== Chống xử lý lặp/Spam
  async function isDiscordSent(code){ const g = await getFromLocal(`TIS:discordSent:${code}`); return !!g[`TIS:discordSent:${code}`]; }
  function markDiscordSent(code){ return saveToLocal({ [`TIS:discordSent:${code}`]: true }); }

  // ===== Pipeline chính
  async function captureAndNotify(orderCode) {
    const doneKey = `TIS:captureDone:${orderCode}`;
    const gDone = await getFromLocal(doneKey);
    if (gDone[doneKey]) return;
    await saveToLocal({ [doneKey]: true });

    // Fallback từ DOM + draft
    const recDom = scrapeReceiverFromCreatePageDOM() || {};
    const draft = await getFromLocal("TIS:lastReceiverDraft");
    let receiver = {
      name:    (recDom.name || draft?.["TIS:lastReceiverDraft"]?.receiver?.name || "").trim(),
      phone:   digitsOnly(recDom.phone || draft?.["TIS:lastReceiverDraft"]?.receiver?.phone || ""),
      address: (recDom.address || draft?.["TIS:lastReceiverDraft"]?.receiver?.address || "").trim()
    };

    // Ưu tiên payload CreateOrder
    const fullJson = await getFullOrderByCode(orderCode);
    receiver = mergeReceiverFromFullJson(fullJson, receiver);

    // Lưu cache & gửi Discord
    await saveOrderToCache(orderCode, receiver);
    try { await notifyDiscord(orderCode, receiver, fullJson); } catch(e){ console.warn("notifyDiscord error:", e); }

    // Overlay
    showSuccessOverlay(orderCode, receiver);
  }

  function findReceiverSectionRoot() {
    const candidates = Array.from(document.querySelectorAll('section, article, div, [class*="card" i], [class*="panel" i]'));
    for (const el of candidates) {
      const t = (el.innerText || "").toLowerCase();
      if (t.includes("người nhận")) return el;
    }
    return null;
  }
  function scrapeReceiverFromCreatePageDOM() {
    const root = findReceiverSectionRoot();
    if (!root) return null;
    // name
    let name = ""; const nameEl = root.querySelector(".bold-text") || root.querySelector('[class*="name" i]');
    if (nameEl) name = (nameEl.textContent || "").trim();
    // phone
    let phone = "";
    const labels = Array.from(root.querySelectorAll("*")).filter(el => /số\s*điện\s*thoại/i.test((el.textContent || "").trim()));
    for (const el of labels) {
      const s = ((el.textContent || "") + " " + (el.nextElementSibling?.textContent || "")).trim();
      const m = s.match(/\+?\d[\d\s\-]{7,}\d/);
      if (m) { phone = digitsOnly(m[0]); break; }
    }
    if (!phone) {
      const txt = (root.innerText || "").replace(/\s+/g, " ");
      const digits = (txt.match(/\d{8,15}/g) || []).sort((a,b)=>b.length-a.length);
      if (digits.length) phone = digits[0];
    }
    // address
    let address = "";
    const lines = (root.innerText || "").split("\n").map(s=>s.trim()).filter(Boolean);
    const cands = lines.filter(l => !/số\s*điện\s*thoại/i.test(l) && l.length>10 && !BAD_ADDR_PAT.test(l));
    if (cands.length) address = cands.sort((a,b)=>b.length-a.length)[0];

    return { name, phone, address };
  }

  /* ===================== NETWORK HOOK ===================== */
  function hookCreateOrderNetwork() {
    const _fetch = window.fetch;
    window.fetch = async (...args) => {
      const res = await _fetch(...args);
      try { await maybeCaptureOrder(args, res.clone()); } catch {}
      return res;
    };
    const _open = XMLHttpRequest.prototype.open;
    const _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) { this.__url = url||""; this.__method = method||""; return _open.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (body) {
      this.__body = body;
      const _onload = this.onload;
      this.onload = async () => {
        try { await maybeCaptureOrder([this.__url, { method: this.__method, body: this.__body }], this); } catch {}
        if (_onload) _onload.call(this);
      };
      return _send.apply(this, arguments);
    };
  }

  async function maybeCaptureOrder(args, resOrXhr) {
    const reqUrl  = (typeof args[0] === "string" ? args[0] : (args[0] && args[0].url)) || "";
    const reqInit = args[1] || {};
    const method  = (reqInit.method || "GET").toUpperCase();
    if (!/POST|PUT/.test(method)) return;
    if (!/order|create|tao|dat|don/gi.test(reqUrl)) return;

    let json = null;
    try {
      if ("json" in resOrXhr) json = await resOrXhr.json();
      else if ("responseText" in resOrXhr) json = JSON.parse(resOrXhr.responseText || "{}");
    } catch {}

    if (!json) return;

    const code = json.orderCode || json.code || json.OrderCode ||
                 (json.data && (json.data.orderCode || json.data.code));
    if (!code) return;

    await saveToLocal({
      [`TIS:orderFull:${code}`]: { data: json, ts: Date.now() },
      "TIS:lastOrderCode": code
    });

    await captureAndNotify(code);
  }

  /* ===================== LOCAL CACHE ===================== */
  async function saveOrderToCache(orderCode, receiver) {
    await saveToLocal({ [`TIS:orderCache:${orderCode}`]: { receiver, ts: Date.now() } });
  }
  function cleanupOldCache() {
    chrome.storage.local.get(null, (all) => {
      const now = Date.now();
      for (const k of Object.keys(all)) {
        if (k.startsWith("TIS:orderCache:")) {
          const ts = all[k]?.ts || 0; if (now - ts > ONE_DAY_MS) chrome.storage.local.remove(k);
        }
      }
      const snap = all["TIS:lastReceiverDraft"];
      if (snap && now - (snap.ts || 0) > FIFTEEN_MIN) chrome.storage.local.remove("TIS:lastReceiverDraft");
    });
  }
  function getFullOrderByCode(code) {
    return new Promise((resolve) => chrome.storage.local.get(`TIS:orderFull:${code}`, (g) => resolve(g[`TIS:orderFull:${code}`]?.data || null)));
  }

  /* ===================== OBSERVERS (NHÁP) ===================== */
  function bindInputs(selector, handler){
    $$(selector).forEach(el => { el.addEventListener("input", handler, true); el.addEventListener("change", handler, true); });
    new MutationObserver(()=> $$(selector).forEach(el => {
      if (!el.__tisBind){ el.__tisBind = true; el.addEventListener("input", handler, true); el.addEventListener("change", handler, true); }
    })).observe(document.documentElement,{childList:true,subtree:true});
  }
  function getVal(sel){ const el=$(sel); return el ? ("value" in el ? (el.value||"").trim() : (el.textContent||"").trim()) : ""; }
  function observeDraftInputs() {
    const nameSel = [
      'input[name*="receiver"][name*="name" i]',
      'input[name*="toName" i]',
      'input[placeholder*="tên" i]',
      'input[placeholder*="họ tên" i]'
    ].join(",");
    const addrSel = [
      'textarea[name*="receiver"][name*="address" i]',
      'textarea[name*="toAddress" i]',
      'textarea[placeholder*="địa chỉ" i]',
      'input[name*="address" i]',
      'input[placeholder*="địa chỉ" i]'
    ].join(",");

    const update = () => {
      const name = getVal(nameSel), address = getVal(addrSel);
      chrome.storage.local.get("TIS:lastReceiverDraft", (g) => {
        const prev = g["TIS:lastReceiverDraft"] || { receiver: {}, ts: 0 };
        chrome.storage.local.set({
          "TIS:lastReceiverDraft": {
            receiver: { name: name || prev.receiver.name || "", phone: prev.receiver.phone || "", address: address || prev.receiver.address || "" },
            ts: Date.now()
          }
        });
      });
    };
    bindInputs(nameSel, update);
    bindInputs(addrSel, update);
  }
  function observePhoneInputs() {
    const sel = [
      'input[type="tel"]','input[name*="phone" i]','input[name*="sdt" i]',
      'input[placeholder*="điện thoại" i]','input[placeholder*="sdt" i]'
    ].join(",");
    const save = (el) => {
      const fn = () => {
        const name = getVal('input[name*="receiver"][name*="name" i], input[name*="toName" i], input[placeholder*="tên" i], input[placeholder*="họ tên" i]');
        const address = getVal('textarea[name*="receiver"][name*="address" i], textarea[name*="toAddress" i], textarea[placeholder*="địa chỉ" i], input[name*="address" i], input[placeholder*="địa chỉ" i]');
        const raw = digitsOnly(el.value || "");
        chrome.storage.local.set({ "TIS:lastReceiverDraft": { receiver: { name, phone: raw, address }, ts: Date.now() } });
      };
      el.addEventListener("input", fn, true);
      el.addEventListener("change", fn, true);
      el.addEventListener("blur", fn, true);
    };
    $$(sel).forEach(save);
    new MutationObserver(()=> $$(sel).forEach(save))
      .observe(document.documentElement,{childList:true,subtree:true});
  }

  /* ===================== DISCORD ===================== */
  async function notifyDiscord(orderCode, receiver, fullJson) {
    if (await isDiscordSent(orderCode)) return;

    const webhook = await getWebhookUrl();
    if (!webhook) return;

    const creator = await getCreatorName(); // << tiêu đề embed
    const title = creator || "TIS";

    const name    = (receiver?.name || "—").trim();
    const phone   = (receiver?.phone && receiver.phone.trim()) ? receiver.phone : "—";
    const address = (receiver?.address || "—").trim();

    const receiverCompanyName = pickFirst(fullJson?.receiverCompanyName, fullJson?.toCompanyName, fullJson?.receiverInfo?.companyName);
    const serviceTypeID = pickFirst(fullJson?.serviceTypeID, fullJson?.serviceType);
    const codAmount = (fullJson?.codAmount != null ? fullJson.codAmount : "");

    const lines = [
      `**Mã đơn:** \`${orderCode}\``,
      `**Người nhận:** ${name || "—"}`,
      `**Địa chỉ:** ${address || "—"}`
    ];
    if (receiverCompanyName) lines.push(`**Công ty:** ${receiverCompanyName}`);
    if (serviceTypeID)      lines.push(`**Dịch vụ:** ${serviceTypeID}`);
    if (codAmount !== "")   lines.push(`**COD:** ${codAmount}`);

    const payload = {
      username: "TIS 247Express Bot",
      embeds: [{
        title,                                  
        description: lines.join("\n"),
        color: 0xE30613,
        footer: { text: "TIS Extension" },
        timestamp: new Date().toISOString()
      }]
    };

    try {
      const res = await fetch(webhook, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        await markDiscordSent(orderCode);
        // --- START: KÍCH HOẠT TẢI LẠI TRANG ---
        sessionStorage.setItem('TIS_AUTO_RELOAD', 'first');
        setTimeout(() => {
            window.location.reload();
        }, 1000);
        // --- END: KÍCH HOẠT TẢI LẠI TRANG ---
      }
    } catch (e) {
      console.warn("Gửi Discord thất bại:", e);
    }
  }

  /* ===================== UI: OVERLAY & IN ===================== */
  function showSuccessOverlay(orderCode, rcv) {
    removeNode("#tis-success-overlay");
    const wrap = document.createElement("div");
    wrap.id = "tis-success-overlay";
    Object.assign(wrap.style, {
      position: "fixed", right: "16px", bottom: "16px", zIndex: "2147483647",
      background: "#fff", border: "1px solid #e5e7eb", borderRadius: "12px",
      boxShadow: "0 10px 20px rgba(0,0,0,0.15)", padding: "14px 16px",
      maxWidth: "480px", fontFamily: "system-ui,-apple-system,Segoe UI,Roboto,Arial", lineHeight: "1.4"
    });

    const title = document.createElement("div");
    Object.assign(title.style, { display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" });
    title.innerHTML = `<div style="font-weight:700">ĐÃ LẤY THÔNG TIN ĐƠN</div>`;
    title.prepend(createLogo());

    const msg = document.createElement("div");
    msg.style.fontSize = "13px";
    msg.innerText = `Mã đơn: ${orderCode}\n📞 ${(rcv.phone || "").replace(/\D/g, "") || "—"}`;

    wrap.appendChild(title);
    wrap.appendChild(msg);
    document.body.appendChild(wrap);
    setTimeout(() => removeNode("#tis-success-overlay"), 20000);
  }

  // ====== PRINT PAGE ======
  let TIS_PRINT_HOLD = false;
  function ensurePrintButton() {
    if ($("#tis-print-now-btn")) return;
    const btn = document.createElement("button");
    btn.id = "tis-print-now-btn";
    btn.textContent = "In ngay";
    Object.assign(btn.style, {
      position: "fixed", right: "16px", bottom: "16px", zIndex: "2147483647",
      background: "#E30613", color: "#fff", border: "none", borderRadius: "10px",
      padding: "10px 14px", fontWeight: "600", boxShadow: "0 8px 16px rgba(0,0,0,0.2)",
      cursor: "pointer"
    });
    btn.onclick = () => window.print();
    document.body.appendChild(btn);
  }

  window.addEventListener("beforeprint", () => {
    $$('input[data-tis-phone="1"]').forEach(inp => {
      inp.setAttribute("value", inp.value || "");
      inp.style.border = "none";
      inp.style.outline = "none";
    });
  });

  function onPrintPage() {
    waitForTables(async () => {
      const orderCodes = getOrderCodesFromQuery();
      const receiverMap = await getReceiversByOrderCodes(orderCodes);
      const draft = await getFromLocal("TIS:lastReceiverDraft");
      renderFooterBoxMulti(receiverMap, orderCodes, draft?.["TIS:lastReceiverDraft"]);
    });
  }

  function waitForTables(cb, retries = 40) {
    if ($$("table").length) cb();
    else if (retries > 0) setTimeout(() => waitForTables(cb, retries - 1), 300);
    else console.warn("Không tìm thấy bảng để in.");
  }

  function getOrderCodesFromQuery() {
    const pk = new URLSearchParams(location.search).get("packages") || "";
    return pk.split(",").map(s => s.trim()).filter(Boolean);
  }

  function getReceiversByOrderCodes(codes) {
    return new Promise((resolve) => {
      if (!codes.length) return resolve({});
      const keys = codes.map(c => `TIS:orderCache:${c}`);
      chrome.storage.local.get(keys, (g) => {
        const map = {};
        codes.forEach((c) => { const v = g[`TIS:orderCache:${c}`]; if (v && v.receiver) map[c] = v.receiver; });
        resolve(map);
      });
    });
  }

  function extractOrderCodeFromText(text) {
    const m = (text || "").match(/[A-Z]{3,}\d{6,}/);
    return m ? m[0] : null;
  }
  function extractMaskedPhoneAround(lines, nameIndex) {
    if (nameIndex !== -1) {
      const from = nameIndex + 1;
      const to   = Math.min(lines.length, nameIndex + 9);
      for (let i = from; i < to; i++) {
        const line = lines[i];
        if (/số\s*điện\s*thoại/i.test(line)) {
          const after = line.split(":").slice(1).join(":").trim();
          if (after) return after;
        }
      }
      for (let i = from; i < to; i++) {
        const digits = (lines[i] || "").replace(/\D/g, "");
        if (digits.length >= 8 && digits.length <= 15) return digits;
      }
    }
    return "";
  }
  function extractNearReceiver(text) {
    const lines = splitLines(text);
    let start = lines.findIndex(l => /người\s*nhận/i.test(l));
    if (start === -1) start = 0;
    let name = "Không xác định", nameIndex = -1;

    for (let i = start; i < Math.min(lines.length, start + 20); i++) {
      const lc = (lines[i] || "").toLowerCase();
      const isName = lc.startsWith("chị") || lc.startsWith("anh") || lc.includes("(ms.") || lc.includes("(mr.)") || (lines[i] || "").includes(" - ");
      if (isName) { name = lines[i]; nameIndex = i; break; }
    }

    const address = (() => {
      for (let i = nameIndex; i < Math.min(lines.length, nameIndex + 4); i++) {
        const curr = lines[i] || "", next = lines[i + 1] || "", next2 = lines[i + 2] || "";
        const lc = curr.toLowerCase();
        const isName = lc.startsWith("chị") || lc.startsWith("anh") || lc.includes("(ms.") || lc.includes("(mr.)") || (curr.includes(" - ") && next);
        if (isName) {
          let addr = next;
          if (/số\s*điện\s*thoại/i.test(addr)) addr = next2;
          else if (next2 && next2.length > 10 && !/số\s*điện\s*thoại/i.test(next2)) addr += ", " + next2;
          if (addr && !/số\s*điện\s*thoại/i.test(addr) && !BAD_ADDR_PAT.test(addr)) return addr;
        }
      }
      return "Không xác định";
    })();

    return { name, address, _nameIndex: nameIndex };
  }

  function renderFooterBoxMulti(receiverMap, orderCodes, draft) {
    const tables = $$("table");
    let totalImages = 0, loadedImages = 0, didPrint = false;

    const tryPrint = () => { if (!didPrint && loadedImages >= totalImages && !TIS_PRINT_HOLD) { didPrint = true; window.print(); } };

    tables.forEach((tbl, idx) => {
      const txt = tbl.innerText || "";
      let code = extractOrderCodeFromText(txt);
      if (!code && idx < orderCodes.length) code = orderCodes[idx];

      const near = extractNearReceiver(txt);
      const nameFromDom = (near.name && near.name !== "Không xác định") ? near.name : "";
      const addrFromDom = (near.address && near.address !== "Không xác định") ? near.address : "";

      let receiver = code ? receiverMap[code] : null;
      if (!receiver && idx === 0 && draft && Date.now() - (draft.ts || 0) <= FIFTEEN_MIN) receiver = draft.receiver;

      const phoneMasked = extractMaskedPhoneAround(splitLines(txt), near._nameIndex);
      let phoneDisplay = "";
if (receiver?.phone) {
  phoneDisplay = receiver.phone;
} else if (idx === 0 && draft?.receiver?.phone && Date.now() - (draft.ts || 0) <= FIFTEEN_MIN) {
  // lấy phone từ bản nháp nếu đơn đầu tiên
  phoneDisplay = draft.receiver.phone;
} else {
  phoneDisplay = phoneMasked;
}

      const name    = nameFromDom || (receiver?.name || "Không xác định");
      const address = addrFromDom || (receiver?.address || "Không xác định");

      const wrapper = document.createElement("div");
      wrapper.style.position = "relative";
      wrapper.style.marginTop = "-8px";

      const box = document.createElement("div");
      Object.assign(box.style, {
        position: "absolute", bottom: "0", left: "0", zIndex: "2147483647",
        background: "#fff", padding: "10px 15px", borderTop: "1px solid #999",
        width: "100%", boxShadow: "0 -2px 4px rgba(0,0,0,0.2)", boxSizing: "border-box",
        display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px"
      });

      const right = document.createElement("div");
      right.style.whiteSpace = "pre-line";
      right.style.flex = "1";
      right.style.fontSize = "13px";

      const title = document.createElement("div");
      title.textContent = "📦 Thông tin người nhận:";
      title.style.fontWeight = "600";
      title.style.marginBottom = "2px";

      const rowName = document.createElement("div");
      rowName.textContent = `👤 Họ tên: ${name}`;

      const rowPhone = document.createElement("div");
      const label = document.createElement("span");
      label.textContent = "📞 SĐT: ";
      const input = document.createElement("input");
      input.type = "text"; input.placeholder = "Nhập SĐT";
      input.value = phoneDisplay;
      input.setAttribute("data-tis-phone", "1");
      Object.assign(input.style,{border:"none",outline:"none",background:"transparent",font:"inherit",padding:"0 2px",minWidth:"120px"});
      const sanitize = () => { input.value = digitsOnly(input.value); };
      ["focus","input"].forEach(ev => { input.addEventListener(ev, () => { TIS_PRINT_HOLD = true; ensurePrintButton(); }, { passive:true }); });
      input.addEventListener("input", sanitize);
      input.addEventListener("change", async () => {
        sanitize(); await savePhoneForOrder(code, input.value);
        if (code){ receiverMap[code] = receiverMap[code] || { name:"", address:"", phone:"" }; receiverMap[code].phone = input.value; }
        const ok = document.createElement("span"); ok.textContent="  ✓ Đã lưu"; ok.style.color="#16a34a"; ok.style.fontWeight="600"; rowPhone.appendChild(ok); setTimeout(()=>ok.remove(),1200);
      });
      rowPhone.appendChild(label); rowPhone.appendChild(input);

      const rowAddr = document.createElement("div");
      rowAddr.textContent = `📍 Địa chỉ: ${address}`;

      right.appendChild(title); right.appendChild(rowName); right.appendChild(rowPhone); right.appendChild(rowAddr);

      totalImages++;
      const logo = createLogo(() => { loadedImages++; tryPrint(); });

      box.appendChild(logo); box.appendChild(right);

      const parent = tbl.parentNode; parent.replaceChild(wrapper, tbl); wrapper.appendChild(tbl); wrapper.appendChild(box);
    });

    if (totalImages === 0) tryPrint();
  }

  async function savePhoneForOrder(code, phone) {
    if (!code) return;
    const key = `TIS:orderCache:${code}`;
    chrome.storage.local.get(key, (g) => {
      const prev = g[key] || { receiver: {}, ts: Date.now() };
      prev.receiver = prev.receiver || {};
      prev.receiver.phone = digitsOnly(phone || "");
      prev.ts = Date.now();
      chrome.storage.local.set({ [key]: prev });
    });
  }

  /* ===================== QUICK WEBHOOK BUTTON ===================== */
  // <<<<<<<<<< BẮT ĐẦU KHỐI CODE THAY ĐỔI
  function ensureLottieIcon() {
    if ($("#tis-lottie-icon")) return;

    // Tạo container cho Lottie
    const iconContainer = document.createElement("div");
    iconContainer.id = "tis-lottie-icon";
    Object.assign(iconContainer.style, {
      position: "fixed",
      right: "16px",
      bottom: "64px",
      zIndex: "2147483647",
      width: "48px", // Kích thước icon
      height: "48px",
      cursor: "pointer",
      background: "#111827",
      borderRadius: "50%",
      boxShadow: "0 8px 16px rgba(255, 255, 255, 1)"
    });

    // Tải và chạy animation
    lottie.loadAnimation({
        container: iconContainer,
        renderer: 'svg',
        loop: true,
        autoplay: true,
        path: chrome.runtime.getURL('ICON.json') // Lấy đường dẫn tới file json
    });
    
    // Gán lại chức năng onClick của nút cũ
    iconContainer.onclick = async () => {
      const cur = await getWebhookUrl();
      const next = window.prompt("Nhập Discord Webhook URL:", cur || "");
      if (next === null) return; // Người dùng bấm Cancel
      if (!/^https:\/\/(ptb\.)?discord\.com\/api\/webhooks\//.test(next.trim())) {
        if (next.trim() !== "") { // Chỉ báo lỗi nếu người dùng nhập gì đó không hợp lệ
           return alert("Webhook URL không hợp lệ.");
        }
      }
      await saveToLocal({ [KEY_WEBHOOK]: next.trim() });
      if (next.trim() !== "") {
        alert("Đã lưu webhook!");
      } else {
        alert("Đã xóa webhook!");
      }
    };

    document.body.appendChild(iconContainer);
  }
  // <<<<<<<<<< KẾT THÚC KHỐI CODE THAY ĐỔI
})();