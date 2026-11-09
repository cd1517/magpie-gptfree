// GUI runs in Magpie's sandboxed frame, with a fresh in-memory capability
// sent on every request. Never write input secrets into persistent browser
// storage, query strings, logs, or plugin options.
(() => {
  const $ = (id) => document.getElementById(id);
  const session = document.querySelector('meta[name="gptfree-session"]')?.content || "";
  const labels = {
    standard: "邮箱 + 密码 + 2FA",
    mail_link: "附邮箱链接",
    access_token: "附带 JWT Token",
  };
  const tokenLabels = {
    expired: "Token 过期 · 将自动重登",
    unexpired_unverified: "Token 待服务器验证",
    unknown: "Token 有效期未知",
    not_yet_valid: "Token 尚未生效",
  };
  const poolTokenBadges = {
    unexpired_unverified: { cls: "good", text: "Token 有效（待请求确认）" },
    expired: { cls: "warn", text: "Token 已过期（会自动重登）" },
    missing: { cls: "bad", text: "无可用 Token" },
    unknown: { cls: "warn", text: "Token 状态未知" },
    not_yet_valid: { cls: "warn", text: "Token 尚未生效" },
    invalid: { cls: "bad", text: "Token 格式异常" },
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
  let preview = null, previewSource = "", lastSeq = 0, polling = null, busy = false, poolBusy = false;
  const jobStates = new Map();
  const rowMessages = new Map();

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
  function countTextLines(text) {
    let lines = 0;
    for (const raw of String(text || "").split(/\r?\n/)) {
      const s = raw.trim();
      if (s && !s.startsWith("#") && !s.startsWith("//")) lines++;
    }
    return lines;
  }
  function updateLineCounter() {
    const n = countTextLines($("pasteAccounts").value);
    $("lineCount").textContent = n + " 行有效文本";
  }
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
  function hasDraftChanges() {
    return $("pasteAccounts").value !== previewSource;
  }
  function canStartImport() {
    return $("consent").checked && !!$("pasteAccounts").value.trim();
  }
  function setBusy(next) {
    busy = next;
    $("selectFile").disabled = busy;
    $("fileInput").disabled = busy;
    $("checkPaste").disabled = busy;
    $("clearPaste").disabled = busy;
    $("pasteAccounts").disabled = busy;
    $("skipInvalid").disabled = busy;
    $("proxyInput").disabled = busy;
    $("consent").disabled = busy;
    $("dropzone").classList.toggle("disabled", busy);
    $("startButton").disabled = busy || !canStartImport();
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
      box.append(el("strong", "",
        "以下行存在格式错误，请直接在上方文本框修改对应行，或勾选「跳过格式错误行，仅导入有效账号」："));
      const ul = el("ul");
      for (const e of preview.errors.slice(0, 20))
        ul.append(el("li", "", "第 " + e.line + " 行：" + e.reason));
      box.append(ul);
      hidden("validation", false);
    } else hidden("validation", true);
    renderPreview(preview.rows);
    hidden("previewBox", false);
    setBusy(busy);
  }
  async function previewText(text, sourceLabel = "文本框内容") {
    if (!text || !text.trim()) {
      notice("请先选择 TXT 文件或在文本框输入账号列表", true);
      return false;
    }
    if (new TextEncoder().encode(text).length > 1024 * 1024) {
      notice("账号列表超过 1 MiB，请分批导入", true);
      return false;
    }
    const wasBusy = busy;
    setBusy(true);
    hidden("progressBox", true);
    jobStates.clear();
    preview = null;
    previewSource = text;
    try {
      const data = await api("preview", { text });
      preview = data;
      renderValidation();
      if (data.errors.length && !$("skipInvalid").checked) {
        notice(sourceLabel + " 已加载到文本框（发现 " + data.errors.length + " 行格式错误）：可直接编辑修改后继续，或勾选「跳过格式错误行」", true);
      } else if (data.errors.length) {
        notice(sourceLabel + " 已解析：" + data.count + " 条有效（已选择跳过 " + data.errors.length + " 条错误行），可点击「导入并授权入池」");
      } else {
        notice(sourceLabel + " 已解析（" + data.count + " 条有效），可继续在文本框微调或点击「导入并授权入池」");
      }
      return true;
    } catch (err) {
      hidden("previewBox", true);
      notice(err.message, true);
      return false;
    } finally { setBusy(wasBusy); }
  }
  async function loadText(file) {
    if (busy || !file) return;
    if (file.size > 1024 * 1024) {
      notice("请选择小于 1 MiB 的 TXT 文件", true);
      return;
    }
    if (!/\.txt$/i.test(file.name) && file.type !== "text/plain") {
      notice("请使用 TXT 文件", true);
      return;
    }
    $("fileName").textContent = file.name + " · " + Math.ceil(file.size / 1024) + " KiB（已填入下方文本框，可直接编辑）";
    const text = await file.text();
    // Put loaded file text straight into the editable textarea so malformed lines
    // can be inspected and corrected without re-uploading.
    $("pasteAccounts").value = text;
    updateLineCounter();
    $("pasteAccounts").focus();
    await previewText(text, "TXT 文件");
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
        const added = info.result?.added ?? info.added ?? 0;
        const failed = info.result?.failed ?? info.failed ?? 0;
        const skipped = info.result?.invalid ?? 0;
        if (info.providerConnected === true)
          notice(`导入完成：新增/更新 ${added} 个账号进入共享号池（失败 ${failed}${skipped ? `，已跳过错误行 ${skipped}` : ""}），多账号自动轮询已就绪`);
        else if (info.providerConnected === false)
          notice(info.message || "账号已入池，但连接 Magpie 号池失败；请检查插件状态", true);
        else
          notice("批量处理完成，可在「我的账号池」查看账号与详细状态；没有可用账号时不会连接供应商");
      } else notice(info.message || "批量导入已停止，未完成的账号可稍后重试", true);
    }
  }
  function stopPolling() {
    if (polling) clearInterval(polling);
    polling = null;
  }
  async function begin() {
    if (busy || !$("consent").checked) return;
    const text = $("pasteAccounts").value;
    const skipInvalid = $("skipInvalid").checked;
    if (!text.trim()) {
      notice("请先选择 TXT 文件或在文本框输入账号", true);
      return;
    }
    if (hasDraftChanges() || !preview) {
      const ok = await previewText(text, "当前编辑文本");
      if (!ok) return;
    }
    if (!preview || !preview.count) {
      notice("没有可导入的有效账号，请检查文本框内容", true);
      return;
    }
    if (preview.errors.length && !skipInvalid) {
      $("previewBox").scrollIntoView({ behavior: "smooth", block: "nearest" });
      notice("仍有 " + preview.errors.length + " 行格式错误：请直接在上方文本框修改，或勾选「跳过格式错误行，仅导入有效账号」", true);
      return;
    }
    setBusy(true);
    jobStates.clear();
    lastSeq = 0;
    $("events").replaceChildren();
    hidden("progressBox", false);
    hidden("againButton", true);
    hidden("cancelButton", false);
    $("progressFill").style.width = "0%";
    try {
      await api("start", {
        mode: "pool",
        consent: true,
        skipInvalid,
        proxy: $("proxyInput").value.trim(),
      });
      $("progressBox").scrollIntoView({ behavior: "smooth", block: "nearest" });
      stopPolling();
      await status();
      notice("已开始 DSH 风格后台 HTTP 批量登录；成功入池的多个账号将自动加入共享号池轮询");
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
  function formatTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : "更新于 " + d.toLocaleString();
  }
  async function refreshAccounts(payload) {
    if (poolBusy || busy) return;
    poolBusy = true;
    $("refreshAllPool").disabled = true;
    try {
      const proxy = ($("poolProxyInput").value || $("proxyInput").value || "").trim();
      const res = await api("accounts/refresh", { ...payload, proxy });
      for (const item of res.results || []) {
        if (item.status === "valid") rowMessages.set(item.id, "上次检测：有效可用");
        else if (item.status === "renewed") rowMessages.set(item.id, "上次刷新：已重新授权并更新 Token");
        else rowMessages.set(item.id, "上次刷新失败：" + (item.reason || "请检查网络或账号状态"));
      }
      await loadPool();
      if (res.failed > 0 && res.renewed === 0 && res.valid === 0)
        notice("检测完成：" + res.failed + " 个账号刷新失败，请检查代理或账号状态", true);
      else
        notice(`检测完成：有效 ${res.valid} 个 · 续期 ${res.renewed} 个 · 失败 ${res.failed} 个`);
    } catch (err) {
      notice(err.message, true);
    } finally {
      poolBusy = false;
      $("refreshAllPool").disabled = false;
    }
  }
  async function loadPool() {
    try {
      const data = await api("accounts");
      $("poolCount").textContent = data.total;
      const summary = data.summary || { total: data.total, valid: 0, needsRenew: 0 };
      $("poolSummary").textContent = data.total
        ? `共 ${summary.total} 个入池账号 · 有效 ${summary.valid} · 待续期/异常 ${summary.needsRenew} · 多账号自动轮询中`
        : "号池暂无账号 · 请先导入账号";
      $("refreshAllPool").disabled = poolBusy || !data.accounts.length;
      const list = $("poolList");
      list.replaceChildren();
      if (!data.accounts.length) {
        list.append(el("div", "empty", "独立号池暂无账号。请在「批量导入」选择 TXT 文件或粘贴账号批量导入。"));
        return;
      }
      for (const account of data.accounts) {
        const item = el("div", "account-row");
        const left = el("div", "account-main");
        const head = el("div", "account-head");
        head.append(el("strong", "", account.email));
        const badge = poolTokenBadges[account.tokenState] || (account.hasAccess
          ? poolTokenBadges.unexpired_unverified
          : poolTokenBadges.missing);
        head.append(el("span", "pill " + badge.cls, badge.text));
        left.append(head);
        const sub = [formatTime(account.updatedAt), rowMessages.get(account.id)].filter(Boolean).join(" · ");
        left.append(el("small", "", sub || "已纳入共享号池轮询 · Token 无明文显示"));
        item.append(left);
        const controls = el("div", "account-buttons");
        const refresh = el("button", "btn secondary small", "检测/刷新");
        refresh.type = "button";
        refresh.disabled = poolBusy;
        refresh.addEventListener("click", async () => {
          refresh.textContent = "处理中…";
          await refreshAccounts({ id: account.id, force: account.tokenState !== "unexpired_unverified" });
        });
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
            rowMessages.delete(account.id);
            await loadPool();
            if (removed.connectionError)
              notice("账号已移除，但 Magpie 供应商状态同步失败", true);
            else if (removed.providerConnected === false)
              notice("最后一个账号已移除，GPTFree 号池已自动断开");
            else
              notice("账号已从本地号池移除，其余账号将继续轮询工作");
          }
          catch (err) { notice(err.message, true); remove.disabled = false; }
        });
        controls.append(refresh, remove);
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
    // Always shown INSIDE Magpie's plugin frame. Choosing a file loads its
    // contents directly into #pasteAccounts so errors can be edited in place.
    document.querySelectorAll(".tab").forEach((button) =>
      button.addEventListener("click", () => tab(button.dataset.tab)));
    $("goImport").addEventListener("click", () => {
      tab("import");
      $("pasteAccounts").focus();
    });
    $("checkPaste").addEventListener("click", async () => {
      if (busy) return;
      await previewText($("pasteAccounts").value, "文本框内容");
    });
    $("clearPaste").addEventListener("click", () => {
      if (busy) return;
      $("pasteAccounts").value = "";
      preview = null;
      previewSource = "";
      jobStates.clear();
      hidden("previewBox", true);
      $("fileName").textContent = "文件内容会直接填入下方文本框；若某行格式不对可直接改好后再导入";
      updateLineCounter();
      setBusy(false);
      notice("已清空输入框");
    });
    $("pasteAccounts").addEventListener("input", () => {
      if (!$("pasteAccounts").value.trim()) {
        preview = null;
        previewSource = "";
        hidden("previewBox", true);
      }
      updateLineCounter();
      setBusy(busy);
    });
    $("skipInvalid").addEventListener("change", () => setBusy(busy));
    $("proxyInput").addEventListener("input", () => {
      $("poolProxyInput").value = $("proxyInput").value;
    });
    $("poolProxyInput").addEventListener("input", () => {
      $("proxyInput").value = $("poolProxyInput").value;
    });
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
    $("startButton").addEventListener("click", begin);
    $("cancelButton").addEventListener("click", cancel);
    $("againButton").addEventListener("click", () => {
      stopPolling(); preview = null; previewSource = ""; jobStates.clear();
      hidden("previewBox", true); hidden("progressBox", true);
      $("fileName").textContent = "文件内容会直接填入下方文本框；若某行格式不对可直接改好后再导入";
      $("pasteAccounts").value = "";
      updateLineCounter();
      $("cancelButton").textContent = "停止导入"; $("cancelButton").disabled = false;
      setBusy(false);
      $("pasteAccounts").focus();
      notice("文本框已清空，可以继续批量追加下一批账号到同一个号池");
    });
    $("refreshAccounts").addEventListener("click", loadPool);
    $("refreshAllPool").addEventListener("click", () => refreshAccounts({ all: true }));
    window.addEventListener("message", (ev) => {
      if (ev.data?.magpie === 1 && ev.data?.event === "action") {
        const id = ev.data?.data?.id;
        if (id === "manage-pool") tab("pool");
        else if (id === "batch-import") {
          tab("import");
          $("pasteAccounts").focus();
        }
      }
    });
    if (location.hash === "#action=manage-pool") tab("pool");
    else if (location.hash === "#action=batch-import") $("pasteAccounts").focus();
    updateLineCounter();
    setBusy(false);
    loadPool();
    status();
  }
  setup();
})();
