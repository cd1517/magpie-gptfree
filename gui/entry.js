(async () => {
  const status = document.querySelector("#state");
  try {
    await magpie.ready;
    const options = await magpie.options.get();
    const port = Number(options?.port) || 37986;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
      throw new Error("插件端口不合法");
    // The static page cannot fetch due to Magpie's strict CSP. Navigate the
    // SAME sandboxed frame to the plugin service; the service hosts the GUI
    // and its own authenticated API.
    const base = magpie.service || ("http://127.0.0.1:" + port + "/");
    const target = new URL("ui", base);
    if (target.protocol !== "http:" && target.protocol !== "https:")
      throw new Error("本地服务地址无效");
    // Same as the community magpie-chat page: WebKit can silently leave
    // the sandboxed frame on this bootstrap screen when localhost isn't
    // ready. Offer an IN-MAGPIE retry, not an external browser page.
    setTimeout(() => {
      const stillHere = document.querySelector("#state");
      if (!stillHere) return;
      stillHere.textContent = "本地导入服务尚未连接，请检查插件是否启用后重试。";
      if (!document.querySelector("#retry")) {
        const retry = document.createElement("button");
        retry.id = "retry";
        retry.type = "button";
        retry.textContent = "重新连接";
        retry.addEventListener("click", () => location.reload());
        stillHere.parentNode.appendChild(retry);
      }
    }, 6000);
    // Navigates only this sandboxed iframe, NEVER opens a browser tab.
    location.replace(target.href);
  } catch {
    status.textContent = "无法连接 GUI 后端。请确保插件已启用，并检查本地服务端口是否被占用。";
  }
})();
