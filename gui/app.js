// GUI runs in Magpie's sandboxed frame, with a fresh in-memory capability
// sent on every request. Never write input secrets into storage, the DOM,
// console, query strings, or plugin options.
(() => {
  const $ = (id) => document.getElementById(id);
  const session = document.querySelector('meta[name="gptfree-session"]')?.content || "";
  const labels = {
    standard: "邮箱 + 密码 + 2FA",
    mail_link: "附邮箱链接",
    access_token: "附带 JWT Token",
  };
  const tokenLabels = {
    expired: "Token 过期 · 需要授权",
    unexpired_unverified: "Token 待服务器验证",
    unknown: "Token 有效期未知",
    not_yet_valid: "Token 尚未生效",
  };
  const stateLabels = {
    authorizing: "正在授权",
    added: "导入成功",
    token_reused: "Token 已验证复用",
    token_expired: "Token 过期",
    token_needs_oauth: "需要 OAuth",
    token_unverified: "需要验证",
    mail_link_ignored: "邮箱链接已识别",
    failed: "授权失败",
  };
  let preview = null, lastSeq = 0, polling = null, busy = false;
  const jobStates = new Map();

  function el(tag, className, content) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (content != null) n.textContent = String(content);
    return n;
  }
  function notice(message, error = false) {
    const n = $("notice");
    n.textContent = message;
    n.className = "notice" + (error ? " error" : "");
  }
  function hidden(id, yes) { $(id).classList.toggle("hidden", yes); }
  async function api(route, data = undefined) {
    const opts = {
      method: data === undefined ? "GET" : "POST",
      headers: { "X-GPTFree-Session": session },
      cache: "no-store",
      credentials: "omit",
    };
    if (data !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(data);
    }
    let response;
    try { response = await fetch("api/" + route, opts); }
    catch { throw new Error("无法连接本地导入服务，请重新打开 Magpie 插件页面"); }
    let json;
    try { json = await response.json(); }
    catch { throw new Error("本地服务返回无效响应"); }
    if (!response.ok) throw new Error(json.error || "操作失败");
    return json;
  }
  function setBusy(next) {
    busy = next;
    $("selectFile").disabled = busy;
    $("fileInput").disabled = busy;
    $("startButton").disabled = busy || !preview?.count || !!preview?.errors?.length || !$("consent").checked;
    document.querySelectorAll('input[name="mode"]').forEach((input) => input.disabled = busy);
    $("consent").disabled = busy;
    $("dropzone").classList.toggle("disabled", busy);
  }
  function renderPreview(rows) {
    const tbody = $("previewRows");
    const nodes = [];
    for (const row of rows) {
      const tr = document.createElement("tr");
      tr.dataset.line = row.line;
      const status = jobStates.get(row.line);
      const cols = [
        "#" + row.line, row.email,
        labels[row.format] || row.format,
        status ? stateLabels[status] || status :
          row.tokenState ? tokenLabels[row.tokenState] || "待验证" : "等待导入",
      ];
      for (const [i, val] of cols.entries()) {
        const td = el("td", i === 3 ? "status-cell" : "", val);
        tr.append(td);
      }
      nodes.push(tr);
    }
    tbody.replaceChildren(...nodes);
  }
  function renderValidation() {
    $("counts").textContent = preview.count + " 条有效 · " +
      preview.duplicates + " 条重复 · " + preview.errors.length + " 条错误";
    const box = $("validation");
    box.replaceChildren();
    if (preview.errors.length) {
      box.append(el("strong", "", "请先修正以下格式错误："));
      const ul = el("ul");
      for (const e of preview.errors.slice(0, 20))
        ul.append(el("li", "", "第 " + e.line + " 行：" + e.reason));
      box.append(ul);
      hidden("validation", false);
    } else hidden("validation", true);
    renderPreview(preview.rows);
    hidden("previewBox", false);
    hidden("actionsBox", false);
    setBusy(false);
  }
  async function loadText(file) {
    if (busy) return;
    if (!file || file.size > 1024 * 1024) {
      notice("请选择小于 1 MiB 的 TXT 文件", true);
      return;
    }
    if (!/\.(txt|csv)$/i.test(file.name) && file.type && file.type !== "text/plain") {
      notice("请使用 TXT 文本文件", true);
      return;
    }
    setBusy(true);
    hidden("progressBox", true);
    jobStates.clear();
    preview = null;
    $("fileName").textContent = file.name + " · " + Math.ceil(file.size / 1024) + " KiB";
    try {
      let text = await file.text();
      const data = await api("preview", { text });
      // Only the backend draft keeps raw contents until the user starts.
      text = "";
      preview = data;
      renderValidation();
      notice("文件已安全解析；请检查账号格式并选择导入模式");
    } catch (err) {
      hidden("previewBox", true);
      hidden("actionsBox", true);
      notice(err.message, true);
    } finally { setBusy(false); }
  }
  function addEvent(entry) {
    const div = el("div", "event");
    div.append(el("span", "event-dot " + entry.state));
    div.append(el("span", "event-account", "第 " + entry.line + " 行 · " + entry.email));
    div.append(el("span", "event-state", stateLabels[entry.state] || entry.state));
    if (entry.reason) div.append(el("span", "event-reason", entry.reason));
    $("events").prepend(div);
    if ($("events").children.length > 100) $("events").lastElementChild.remove();
    if (entry.line) jobStates.set(entry.line, entry.state);
  }
  async function status() {
    let info;
    try { info = await api("status"); }
    catch (err) { stopPolling(); notice(err.message, true); return; }
    if (info.state === "idle") return;
    const incoming = info.events || [];
    if (incoming.length && incoming.at(-1).seq < lastSeq) {
      $("events").replaceChildren();
      lastSeq = 0;
    }
    for (const entry of incoming.filter((event) => event.seq > lastSeq)) addEvent(entry);
    if (incoming.length) lastSeq = incoming.at(-1).seq;
    if (preview?.rows) renderPreview(preview.rows);
    hidden("progressBox", false);
    if (info.state === "running") {
      setBusy(true);
      if (!polling) polling = setInterval(status, 850);
    }
    $("doneCount").textContent = String(info.done || 0);
    $("addedCount").textContent = String(info.result?.added ?? info.added ?? 0);
    $("reusedCount").textContent = String(info.result?.reused ?? info.reused ?? 0);
    $("failedCount").textContent = String(info.result?.failed ?? info.failed ?? 0);
    const percent = Math.round((info.done || 0) / Math.max(1, info.total) * 100);
    $("progressFill").style.width = percent + "%";
    $("progressTrack").setAttribute("aria-valuenow", String(percent));
    $("progressCaption").textContent = (info.done || 0) + " / " + info.total + " · " +
      ({ running: "正在导入", completed: "已完成", canceled: "已取消", error: "导入异常" }[info.state] || "");
    if (info.state !== "running") {
      stopPolling();
      setBusy(false);
      hidden("cancelButton", true);
      hidden("againButton", false);
      await loadPool();
      if (info.state === "completed") {
        if (info.providerConnected === true)
          notice("账号已完成导入及自动授权，GPTFree 号池已连接 Magpie，可以直接选择可用模型");
        else if (info.providerConnected === false)
          notice(info.message || "账号已入池，但连接 Magpie 号池失败；请检查插件状态", true);
        else if (info.mode === "native")
          notice("账号导入完成；成功授权的账号已直接写入 Magpie 原生 Codex 账号池");
        else
          notice("账号导入完成，可在「我的账号池」查看；当前批次没有可用账号时不会连接供应商");
      } else notice(info.message || "批量导入已停止，未完成的账号可稍后重试", true);
    }
  }
  function stopPolling() {
    if (polling) clearInterval(polling);
    polling = null;
  }
  async function begin() {
    if (!preview || preview.errors.length || !$("consent").checked || busy) return;
    setBusy(true);
    jobStates.clear();
    lastSeq = 0;
    $("events").replaceChildren();
    hidden("progressBox", false);
    hidden("againButton", true);
    hidden("cancelButton", false);
    $("progressFill").style.width = "0%";
    try {
      const mode = document.querySelector('input[name="mode"]:checked')?.value || "pool";
      await api("start", { mode, consent: true });
      $("progressBox").scrollIntoView({ behavior: "smooth", block: "nearest" });
      stopPolling();
      await status();
      notice("已开始导入，请在出现登录页面时完成必要验证");
    } catch (err) {
      setBusy(false);
      hidden("progressBox", true);
      notice(err.message, true);
    }
  }
  async function cancel() {
    try {
      await api("cancel", {});
      $("cancelButton").disabled = true;
      $("cancelButton").textContent = "正在停止…";
      notice("已请求停止；当前账号的授权操作正在取消");
    } catch (err) { notice(err.message, true); }
  }
  async function loadPool() {
    try {
      const data = await api("accounts");
      $("poolCount").textContent = data.total;
      const list = $("poolList");
      list.replaceChildren();
      if (!data.accounts.length) {
        list.append(el("div", "empty", "独立号池暂无账号。先在「批量导入」中选择 Token 号池模式。"));
        return;
      }
      for (const account of data.accounts) {
        const item = el("div", "account-row");
        const left = el("div", "account-main");
        left.append(el("strong", "", account.email));
        left.append(el("small", "", account.hasAccess ? "Token 已保存 · 状态以实际请求为准" : "无可用 Token"));
        item.append(left);
        const controls = el("div", "account-buttons");
        const remove = el("button", "btn secondary small", "移除");
        remove.type = "button";
        let confirming = false;
        remove.addEventListener("click", async () => {
          if (!confirming) {
            confirming = true;
            remove.classList.add("danger");
            remove.textContent = "确认移除";
            return;
          }
          remove.disabled = true;
          try {
            const removed = await api("remove", { id: account.id });
            await loadPool();
            if (removed.connectionError)
              notice("账号已移除，但 Magpie 供应商状态同步失败", true);
            else if (removed.providerConnected === false)
              notice("最后一个账号已移除，GPTFree 号池已自动断开");
            else
              notice("账号已从本地号池移除，其余账号可继续使用");
          }
          catch (err) { notice(err.message, true); remove.disabled = false; }
        });
        controls.append(remove);
        item.append(controls);
        list.append(item);
      }
    } catch (err) {
      $("poolList").replaceChildren(el("p", "muted", "无法读取号池：" + err.message));
    }
  }
  function tab(next) {
    document.querySelectorAll(".tab").forEach((button) => {
      const selected = button.dataset.tab === next;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", selected ? "true" : "false");
    });
    hidden("importPanel", next !== "import");
    hidden("poolPanel", next !== "pool");
    if (next === "pool") loadPool();
  }
  function setup() {
    if (document.body.dataset.entry === "provider") {
      // The Providers sign-in only controls the GPTFree *pool*.
      // Native Codex import is a separate built-in account provider.
      const native = document.querySelector('input[name="mode"][value="native"]');
      if (native) {
        native.disabled = true;
        native.closest(".mode-card")?.classList.add("disabled");
        native.closest(".mode-card")?.append(el("small", "muted", "如需导入 Magpie 原生 Codex，请使用左侧 Plugins → GPTFree 账号导入"));
      }
      notice("已从 GPTFree 供应商进入。选择 TXT 并导入成功后，Magpie 将自动完成连接，无需再点击登录。");
    }
    document.querySelectorAll(".tab").forEach((button) =>
      button.addEventListener("click", () => tab(button.dataset.tab)));
    $("selectFile").addEventListener("click", (event) => {
      event.stopPropagation(); $("fileInput").click();
    });
    $("dropzone").addEventListener("click", (event) => {
      if (!busy && event.target !== $("selectFile")) $("fileInput").click();
    });
    $("dropzone").addEventListener("keydown", (event) => {
      if (!busy && ["Enter", " "].includes(event.key)) { event.preventDefault(); $("fileInput").click(); }
    });
    $("fileInput").addEventListener("change", (event) => {
      loadText(event.target.files?.[0]);
      event.target.value = "";
    });
    $("dropzone").addEventListener("dragover", (event) => {
      event.preventDefault(); $("dropzone").classList.add("dragging");
    });
    $("dropzone").addEventListener("dragleave", () => $("dropzone").classList.remove("dragging"));
    $("dropzone").addEventListener("drop", (event) => {
      event.preventDefault(); $("dropzone").classList.remove("dragging");
      loadText(event.dataTransfer?.files?.[0]);
    });
    $("consent").addEventListener("change", () => setBusy(busy));
    document.querySelectorAll('input[name="mode"]').forEach((input) =>
      input.addEventListener("change", () => {
        document.querySelectorAll(".mode-card").forEach((card) =>
          card.classList.toggle("selected", card.querySelector("input").checked));
      }));
    $("startButton").addEventListener("click", begin);
    $("cancelButton").addEventListener("click", cancel);
    $("againButton").addEventListener("click", () => {
      stopPolling(); preview = null; jobStates.clear();
      hidden("previewBox", true); hidden("actionsBox", true);
      hidden("progressBox", true); $("fileName").textContent = "请重新选择一个 TXT 文件";
      $("cancelButton").textContent = "停止导入"; $("cancelButton").disabled = false;
      notice("可以导入下一批账号");
    });
    $("refreshAccounts").addEventListener("click", loadPool);
    loadPool();
    status();
  }
  setup();
})();
