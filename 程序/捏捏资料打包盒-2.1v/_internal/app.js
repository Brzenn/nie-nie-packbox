(() => {
  const OPENLIST = "https://openlist.truraly.fun";
  const REMOTE_ROOT_DEFAULT = "/成贤学院课程攻略共享计划/资料库";
  const LOCAL_HINT = "http://127.0.0.1:8765";

  /** @type {'remote'|'local'} */
  let mode = "remote";
  /** @type {null | {base:string, resourceRoot:string, remoteRoot:string}} */
  let server = null;
  let remoteRoot = REMOTE_ROOT_DEFAULT;
  /** 直连 OpenList（页面单独打开时用） */
  let directOk = true;

  /** @type {{name:string, rel:string}[]} */
  let courses = [];
  let activeCourse = null;
  let currentRel = "";
  let currentItems = [];
  let jobTimer = null;
  /** 当前进度条所属的下载任务与课程 */
  let activeJob = null; // { id, rel }

  const els = {
    search: document.getElementById("search"),
    courseList: document.getElementById("course-list"),
    courseCount: document.getElementById("course-count"),
    reload: document.getElementById("reload-courses"),
    emptyState: document.getElementById("empty-state"),
    coursePanel: document.getElementById("course-panel"),
    courseTitle: document.getElementById("course-title"),
    courseCrumb: document.getElementById("course-crumb"),
    sourceLabel: document.getElementById("source-label"),
    fileStats: document.getElementById("file-stats"),
    sizeStats: document.getElementById("size-stats"),
    fileTree: document.getElementById("file-tree"),
    breadcrumbs: document.getElementById("breadcrumbs"),
    btnDownload: document.getElementById("btn-download"),
    btnFolder: document.getElementById("btn-download-folder"),
    btnOpenLocal: document.getElementById("btn-open-local"),
    progressWrap: document.getElementById("progress-wrap"),
    progressFill: document.getElementById("progress-fill"),
    progressText: document.getElementById("progress-text"),
    toast: document.getElementById("toast"),
    serverBanner: document.getElementById("server-banner"),
    serverStatus: document.getElementById("server-status"),
    savePath: document.getElementById("save-path"),
    tabs: document.querySelectorAll(".tab"),
  };

  function toast(msg, ms = 3000) {
    els.toast.textContent = msg;
    els.toast.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => els.toast.classList.add("hidden"), ms);
  }

  function formatSize(n) {
    if (!n || n < 0) return "—";
    if (n < 1024) return `${n} B`;
    const units = ["KB", "MB", "GB"];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
  }

  function joinRel(parent, name) {
    return parent ? `${parent}/${name}` : name;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function highlight(text, query) {
    const safe = escapeHtml(text);
    const q = (query || "").trim();
    if (!q) return safe;
    try {
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
      return safe.replace(re, (m) => `<mark>${m}</mark>`);
    } catch {
      return safe;
    }
  }

  function sortByName(list) {
    const collator = new Intl.Collator(["zh-Hans-CN", "en"], {
      numeric: true,
      sensitivity: "base",
    });
    return [...list].sort((a, b) => {
      const aAscii = /^[\x00-\x7F]/.test(a.name) ? 0 : 1;
      const bAscii = /^[\x00-\x7F]/.test(b.name) ? 0 : 1;
      if (aAscii !== bAscii) return aAscii - bAscii;
      return collator.compare(a.name, b.name);
    });
  }

  async function tryPing(base) {
    const res = await fetch(`${base}/api/ping`, { cache: "no-store" });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || !json.ok) return null;
    return {
      base: base.replace(/\/$/, ""),
      resourceRoot: json.resource_root || "",
      remoteRoot: json.remote_root || REMOTE_ROOT_DEFAULT,
    };
  }

  async function detectServer() {
    const candidates = [];
    // 相对路径（经 server.py 访问时）
    candidates.push("");
    // 页面被 file:// 或其他端口打开时，探测本机服务
    candidates.push(LOCAL_HINT);
    if (location.protocol === "http:" || location.protocol === "https:") {
      candidates.push(`${location.protocol}//127.0.0.1:${location.port || 8765}`);
    }

    for (const base of candidates) {
      try {
        const info = await tryPing(base);
        if (info) {
          server = info;
          remoteRoot = info.remoteRoot || REMOTE_ROOT_DEFAULT;
          els.serverBanner.classList.add("hidden");
          els.serverStatus.textContent = "本地服务已连接 · 可直接下载到磁盘";
          els.serverStatus.classList.add("ok");
          els.savePath.textContent = info.resourceRoot ? `保存到 ${info.resourceRoot}` : "";
          const fullUrl = info.base || LOCAL_HINT;
          const fullEl = document.getElementById("full-url");
          if (fullEl) fullEl.textContent = fullUrl;
          document.getElementById("btn-open-full")?.classList.add("hidden");
          return true;
        }
      } catch {
        /* try next */
      }
    }
    server = null;
    els.serverBanner.classList.remove("hidden");
    els.serverStatus.textContent = "未连接本地服务 · 仅浏览模式";
    els.serverStatus.classList.remove("ok");
    els.savePath.textContent = "";
    document.getElementById("btn-open-full")?.classList.remove("hidden");
    return false;
  }

  // ---------- 远程列表：优先本地代理，失败则直连 OpenList ----------

  async function remoteListViaServer(rel) {
    const base = server.base;
    const path = rel ? `${remoteRoot}/${rel}` : remoteRoot;
    const res = await fetch(`${base}/api/remote/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    return json.items || [];
  }

  async function remoteListDirect(rel) {
    const path = rel ? `${REMOTE_ROOT_DEFAULT}/${rel}` : REMOTE_ROOT_DEFAULT;
    const all = [];
    let page = 1;
    for (;;) {
      const res = await fetch(`${OPENLIST}/api/fs/list`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, page, per_page: 100 }),
      });
      const json = await res.json();
      if (json.code !== 200) throw new Error(json.message || "列表失败");
      const content = json.data?.content || [];
      all.push(...content);
      const total = json.data?.total ?? all.length;
      if (all.length >= total || content.length === 0) break;
      page += 1;
    }
    return all.map((it) => ({
      name: it.name,
      is_dir: !!it.is_dir,
      size: it.size || 0,
    }));
  }

  async function remoteList(rel) {
    if (server) {
      try {
        return await remoteListViaServer(rel);
      } catch (err) {
        console.warn("server list failed, fallback direct", err);
      }
    }
    directOk = true;
    return remoteListDirect(rel);
  }

  async function remoteGetRaw(rel) {
    const path = `${REMOTE_ROOT_DEFAULT}/${rel}`;
    const res = await fetch(`${OPENLIST}/api/fs/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const json = await res.json();
    if (json.code !== 200) throw new Error(json.message || "获取失败");
    return json.data;
  }

  async function fetchFileBlob(rel) {
    const info = await remoteGetRaw(rel);
    const raw = info.raw_url;
    if (!raw) throw new Error("无下载链接");
    const res = await fetch(raw);
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    return res.blob();
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function setProgress(pct, text) {
    // 只在仍停留在该课程时显示进度
    if (activeJob && activeCourse && activeJob.rel !== activeCourse.rel) return;
    els.progressWrap.classList.remove("hidden");
    els.progressFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    if (text) els.progressText.textContent = text;
  }

  function hideProgress() {
    els.progressWrap.classList.add("hidden");
    els.progressFill.style.width = "0%";
    els.progressText.textContent = "准备中…";
  }

  function apiBase() {
    return server ? server.base : "";
  }

  async function startServerDownload(rel, label, modeKind) {
    const res = await fetch(`${apiBase()}/api/download/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rel, label, mode: modeKind }),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    return json.id;
  }

  function pollJob(id, jobRel) {
    clearInterval(jobTimer);
    activeJob = { id, rel: jobRel };
    let fails = 0;
    jobTimer = setInterval(async () => {
      try {
        const res = await fetch(`${apiBase()}/api/download/status?id=${encodeURIComponent(id)}`);
        const job = await res.json();
        if (job.error) throw new Error(job.error);
        const pct = job.total ? (job.done / job.total) * 100 : 5;
        // 仅当用户还在看这门课时更新进度条
        if (activeCourse && jobRel === activeCourse.rel) {
          setProgress(pct, job.message || "下载中…");
        }
        if (job.state && job.state !== "running") {
          clearInterval(jobTimer);
          const stillHere = activeCourse && activeCourse.rel === jobRel;
          els.btnFolder.disabled = false;
          els.btnDownload.disabled = false;
          if (job.state === "error") {
            toast(job.message || "下载失败");
            if (stillHere) {
              hideProgress();
              applyDownloadButton(null);
            }
          } else {
            const errNote = job.errors?.length ? `（${job.errors.length} 个失败）` : "";
            toast(`${job.label || ""}：${job.message || "完成"}${errNote}`, 4000);
            if (stillHere) {
              setProgress(100, job.message || "完成");
              setTimeout(async () => {
                hideProgress();
                const sync = await checkSync(jobRel);
                applyDownloadButton(sync);
                if (sync) {
                  const extra = sync.new_count ? ` · 新增 ${sync.new_count}` : " · 已是最新";
                  els.fileStats.textContent = `远端 ${sync.remote_count} · 本地 ${sync.local_count}${extra}`;
                }
              }, 400);
            }
          }
          if (activeJob && activeJob.id === id) activeJob = null;
        }
      } catch (err) {
        fails += 1;
        console.warn("poll status", err);
        if (fails >= 5) {
          clearInterval(jobTimer);
          toast(err.message || "进度查询失败");
          if (activeCourse && jobRel === activeCourse.rel) {
            els.btnDownload.disabled = false;
            applyDownloadButton(null);
            hideProgress();
          }
          if (activeJob && activeJob.id === id) activeJob = null;
        }
      }
    }, 400);
  }

  /** 无后端时的 ZIP 打包下载（兼容 1.0v 行为） */
  async function downloadTreeAsZip(rel, zipRootName) {
    if (typeof JSZip === "undefined") {
      toast("ZIP 组件未加载；请运行 server.py 使用完整下载");
      return;
    }
    els.btnDownload.disabled = true;
    els.btnFolder.disabled = true;
    try {
      setProgress(2, "扫描目录结构…");
      const files = [];
      async function walk(dirRel) {
        const items = await remoteList(dirRel);
        for (const item of items) {
          const childRel = joinRel(dirRel, item.name);
          setProgress(5, `扫描 ${childRel}`);
          if (item.is_dir) await walk(childRel);
          else files.push({ rel: childRel, name: item.name, size: item.size || 0 });
        }
      }
      await walk(rel || "");
      if (!files.length) {
        toast("该目录下没有文件");
        return;
      }

      const root = rel || "";
      const zipFiles = files.map((f) => ({
        ...f,
        inner: root && f.rel.startsWith(root + "/") ? f.rel.slice(root.length + 1) : f.name,
      }));

      setProgress(8, `共 ${zipFiles.length} 个文件，开始打包…`);
      const zip = new JSZip();
      let done = 0;
      let index = 0;
      async function worker() {
        while (index < zipFiles.length) {
          const i = index++;
          const f = zipFiles[i];
          try {
            setProgress(8 + (done / zipFiles.length) * 88, `下载 ${done + 1}/${zipFiles.length} · ${f.name}`);
            const blob = await fetchFileBlob(f.rel);
            zip.file(`${zipRootName}/${f.inner}`, blob);
          } catch (err) {
            zip.file(`${zipRootName}/${f.inner}.error.txt`, String(err.message || err));
          }
          done += 1;
        }
      }
      await Promise.all([worker(), worker(), worker(), worker()]);
      setProgress(96, "生成 ZIP…");
      const blob = await zip.generateAsync({ type: "blob", compression: "STORE" }, (meta) => {
        setProgress(96 + meta.percent * 0.04, `压缩 ${meta.percent.toFixed(0)}%`);
      });
      const safeName = zipRootName.replace(/[\\/:*?"<>|]/g, "_");
      triggerDownload(blob, `${safeName}.zip`);
      toast(`已打包：${safeName}.zip（浏览器 ZIP 模式）`);
    } catch (err) {
      console.error(err);
      toast(err.message || "打包失败");
    } finally {
      els.btnDownload.disabled = false;
      els.btnFolder.disabled = false;
      hideProgress();
    }
  }

  async function startDownload(rel, label, modeKind = "tree") {
    if (server) {
      els.btnDownload.disabled = true;
      els.btnFolder.disabled = true;
      try {
        const id = await startServerDownload(rel, label, modeKind);
        setProgress(1, modeKind === "update" ? "更新任务已创建…" : "任务已创建…");
        pollJob(id, rel);
      } catch (err) {
        toast(err.message || "无法开始下载");
        els.btnDownload.disabled = false;
        els.btnFolder.disabled = false;
        hideProgress();
      }
      return;
    }

    // 无后端
    if (modeKind === "file") {
      try {
        setProgress(10, `下载 ${label}`);
        const blob = await fetchFileBlob(rel);
        triggerDownload(blob, label);
        toast(`已下载：${label}`);
      } catch (err) {
        toast(err.message || "下载失败");
      } finally {
        hideProgress();
      }
      return;
    }
    await downloadTreeAsZip(rel, label);
  }

  // ---------- 列表渲染 ----------

  async function loadRemoteCourses() {
    els.courseList.innerHTML = `<div class="list-empty">加载课程列表…</div>`;
    els.courseCount.textContent = "加载中…";
    try {
      const items = await remoteList("");
      courses = sortByName(items.filter((x) => x.is_dir)).map((c) => ({
        name: c.name,
        rel: c.name,
      }));
      renderCourses();
    } catch (err) {
      console.error(err);
      directOk = false;
      els.courseList.innerHTML = `<div class="list-empty">${escapeHtml(err.message || "加载失败")}<br/>可点击左下角「打开完整版」</div>`;
      els.courseCount.textContent = "加载失败";
    }
  }

  async function loadLocalCourses() {
    els.courseList.innerHTML = `<div class="list-empty">读取本地课程资源…</div>`;
    els.courseCount.textContent = "加载中…";
    if (!server) {
      els.courseList.innerHTML = `<div class="list-empty">需要本地服务才能读取 课程资源/<br/>请运行 <code>python server.py</code></div>`;
      els.courseCount.textContent = "—";
      courses = [];
      return;
    }
    try {
      const res = await fetch(`${apiBase()}/api/local/list?path=`);
      const data = await res.json();
      courses = sortByName((data.entries || []).filter((x) => x.is_dir)).map((c) => ({
        name: c.name,
        rel: c.rel,
      }));
      renderCourses();
    } catch (err) {
      els.courseList.innerHTML = `<div class="list-empty">${escapeHtml(err.message || "读取失败")}</div>`;
      els.courseCount.textContent = "读取失败";
    }
  }

  function renderCourses() {
    const q = els.search.value.trim().toLowerCase();
    const filtered = courses.filter((c) => !q || c.name.toLowerCase().includes(q));
    const label = mode === "remote" ? "门课程 · 字母序" : "个本地课程";
    els.courseCount.textContent = q
      ? `${filtered.length} / ${courses.length}`
      : `${courses.length} ${label}`;

    if (!filtered.length) {
      els.courseList.innerHTML = `<div class="list-empty">${
        mode === "local" ? "还没有下载过课程" : "没有匹配的课程"
      }</div>`;
      return;
    }

    els.courseList.innerHTML = filtered
      .map(
        (c) => {
          const isActive = activeCourse?.rel === c.rel;
          // 激活项显示当前相对路径；其余默认显示文件夹名
          const meta = isActive && currentRel ? currentRel : c.name;
          return `
      <button type="button" class="course-item${isActive ? " active" : ""}" data-rel="${escapeHtml(c.rel)}" data-name="${escapeHtml(c.name)}">
        <span class="name">${highlight(c.name, els.search.value.trim())}</span>
        <span class="meta">${escapeHtml(meta)}</span>
      </button>`;
        }
      )
      .join("");
  }

  function iconFor(item) {
    if (item.is_dir) return "夹";
    const ext = (item.name.split(".").pop() || "").toLowerCase();
    const map = {
      pdf: "PDF", doc: "DOC", docx: "DOC", ppt: "PPT", pptx: "PPT",
      xls: "XLS", xlsx: "XLS", zip: "ZIP", rar: "RAR", "7z": "7Z",
      md: "MD", txt: "TXT", png: "IMG", jpg: "IMG", jpeg: "IMG", gif: "IMG",
    };
    return map[ext] || "FILE";
  }

  function canPreview(item) {
    if (item.is_dir) return true;
    const ext = (item.name.split(".").pop() || "").toLowerCase();
    return ["pdf", "png", "jpg", "jpeg", "gif", "webp", "txt", "md", "html", "htm", "csv", "json"].includes(ext);
  }

  function renderBreadcrumbs() {
    const parts = currentRel ? currentRel.split("/") : [];
    const rootName = mode === "local" ? "课程资源" : "资料库";
    let html = `<button type="button" data-open="">${rootName}</button>`;
    let acc = "";
    parts.forEach((p) => {
      acc = joinRel(acc, p);
      html += `<span class="sep">/</span><button type="button" data-open="${escapeHtml(acc)}">${escapeHtml(p)}</button>`;
    });
    els.breadcrumbs.innerHTML = html;
  }

  function renderTree() {
    if (!currentItems.length) {
      els.fileTree.innerHTML = `<div class="tree-empty">${
        mode === "local" ? "这里还没有文件，请先下载课程" : "这个文件夹是空的"
      }</div>`;
      return;
    }

    const dirs = currentItems.filter((x) => x.is_dir);
    const files = currentItems.filter((x) => !x.is_dir);
    const sorted = [...sortByName(dirs), ...sortByName(files)];

    els.fileTree.innerHTML = sorted
      .map((item) => {
        const abs = joinRel(currentRel, item.name);
        const sizeLabel = item.is_dir ? "文件夹" : formatSize(item.size);
        let action = "";
        const ext = (item.name.split(".").pop() || "").toLowerCase();
        const webPreview = [
          "png","jpg","jpeg","gif","webp","bmp","svg","ico",
          "pdf","mp4","webm","mov","m4v","ogv","mkv",
          "mp3","wav","ogg","m4a","flac",
          "md","markdown","html","htm",
          "txt","csv","json","log","yml","yaml","xml",
          "css","js","py","java","c","cpp","h",
        ].includes(ext);
        if (item.is_dir) {
          action = `<button type="button" class="btn sm" data-open="${escapeHtml(abs)}">打开</button>`;
        } else if (server && webPreview) {
          action = `<button type="button" class="btn sm primary" data-view="${escapeHtml(abs)}" data-name="${escapeHtml(item.name)}">查看</button>`;
        } else if (server) {
          // PPT/DOC 等：直接用系统默认应用打开，不进网页
          action = `<button type="button" class="btn sm primary" data-open-sys="${escapeHtml(abs)}">查看</button>`;
        } else {
          action = `<button type="button" class="btn sm" data-dl="${escapeHtml(abs)}" data-name="${escapeHtml(item.name)}">查看</button>`;
        }
        return `
        <div class="tree-row${item.is_dir ? " is-dir" : ""}">
          <div class="tree-name">
            <span class="icon">${escapeHtml(iconFor(item))}</span>
            <span class="label" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
          </div>
          <div class="tree-size">${sizeLabel}</div>
          <div class="tree-actions">${action}</div>
        </div>`;
      })
      .join("");
  }

  async function openPath(rel) {
    currentRel = rel;
    renderBreadcrumbs();
    // 大字 = 当前文件夹名；小字 = 相对路径（课程名开头）
    const displayRel = rel || (activeCourse ? activeCourse.rel : "");
    const folderName = displayRel ? displayRel.split("/").pop() : "资料库";
    els.courseTitle.textContent = folderName;
    els.courseCrumb.textContent = displayRel || "资料库";
    renderCourses();
    els.fileTree.innerHTML = `<div class="tree-empty">加载中…</div>`;
    try {
      if (mode === "remote") {
        currentItems = await remoteList(rel);
      } else if (server) {
        const res = await fetch(`${apiBase()}/api/local/list?path=${encodeURIComponent(rel)}`);
        const data = await res.json();
        currentItems = data.entries || [];
      } else {
        currentItems = [];
      }
      renderTree();
      const isCourseRoot = activeCourse && rel === activeCourse.rel;
      els.btnFolder.classList.toggle("hidden", mode !== "remote" || !rel || isCourseRoot);
    } catch (err) {
      console.error(err);
      els.fileTree.innerHTML = `<div class="tree-empty">${escapeHtml(err.message || "加载失败")}</div>`;
    }
  }

  function localUrl(rel) {
    const base = apiBase();
    return `${base}/local/${rel.split("/").map(encodeURIComponent).join("/")}`;
  }

  function viewerUrl(rel, name) {
    const base = apiBase();
    const q = new URLSearchParams({ rel, src: "auto" });
    return `${base}/viewer.html?${q.toString()}`;
  }

  function openViewer(rel, name) {
    if (!server) {
      toast("请运行 start.bat 后使用查看");
      return;
    }
    window.open(viewerUrl(rel, name), "_blank", "noopener");
  }

  function viewLocal(rel, name) {
    openViewer(rel, name);
  }

  async function checkSync(courseRel) {
    if (!server || !courseRel) return null;
    try {
      const res = await fetch(`${apiBase()}/api/sync/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rel: courseRel }),
      });
      return await res.json();
    } catch (err) {
      console.warn("sync check failed", err);
      return null;
    }
  }

  function applyDownloadButton(sync) {
    els.btnDownload.classList.remove("done", "update", "pale");
    // 本地已有课程：更新 + 打开本地文件夹（不显示「查看本地副本 / 已下载」）
    const hasLocal = mode === "local" || (sync && sync.has_local);
    if (hasLocal && server) {
      els.btnOpenLocal.classList.remove("hidden");
      els.btnOpenLocal.textContent = "打开本地文件夹";
      els.btnDownload.dataset.mode = "update";
      if (!sync || typeof sync.new_count !== "number") {
        // 同步检查中
        els.btnDownload.textContent = "更新";
        els.btnDownload.disabled = true;
        els.btnDownload.classList.add("pale");
        return;
      }
      if (sync.new_count > 0) {
        els.btnDownload.textContent = `更新（${sync.new_count}）`;
        els.btnDownload.disabled = false;
        els.btnDownload.classList.add("update");
      } else {
        els.btnDownload.textContent = "更新";
        els.btnDownload.disabled = true;
        els.btnDownload.classList.add("pale");
      }
      return;
    }

    els.btnOpenLocal.classList.add("hidden");
    els.btnDownload.textContent = "打包下载";
    els.btnDownload.disabled = false;
    els.btnDownload.dataset.mode = "tree";
  }

  async function selectCourse(course) {
    activeCourse = course;
    els.emptyState.classList.add("hidden");
    els.coursePanel.classList.remove("hidden");
    els.courseTitle.textContent = course.name;
    els.courseCrumb.textContent = course.name;
    els.sourceLabel.textContent = mode === "local" ? "本地课程资源" : "在线资料库";
    els.fileStats.textContent = "检查更新中…";
    els.sizeStats.textContent = "";
    els.btnOpenLocal.classList.add("hidden");
    els.btnDownload.disabled = true;
    els.btnDownload.textContent = "…";
    // 切换课程时隐藏与本课无关的进度条
    if (activeJob && activeJob.rel !== course.rel) {
      hideProgress();
    }
    renderCourses();
    await openPath(course.rel);

    // 先给出按钮反馈，再等同步结果
    if (mode === "local") {
      applyDownloadButton(null);
    }

    let sync = null;
    if (server) {
      sync = await checkSync(course.rel);
    }
    applyDownloadButton(sync);
    if (sync) {
      const extra = sync.new_count ? ` · 新增 ${sync.new_count}` : " · 已是最新";
      els.fileStats.textContent = `远端 ${sync.remote_count} · 本地 ${sync.local_count}${extra}`;
      els.sizeStats.textContent = "";
    } else if (mode === "remote") {
      try {
        const items = await remoteList(course.rel);
        const files = items.filter((x) => !x.is_dir);
        const dirs = items.filter((x) => x.is_dir);
        els.fileStats.textContent = `本层 ${files.length} 个文件 · ${dirs.length} 个子文件夹`;
        els.sizeStats.textContent = formatSize(files.reduce((s, x) => s + (x.size || 0), 0));
      } catch {
        els.fileStats.textContent = "—";
      }
    } else {
      const files = currentItems.filter((x) => !x.is_dir);
      const dirs = currentItems.filter((x) => x.is_dir);
      els.fileStats.textContent = `本层 ${files.length} 个文件 · ${dirs.length} 个子文件夹`;
      els.sizeStats.textContent = formatSize(files.reduce((s, x) => s + (x.size || 0), 0));
    }
  }

  async function switchMode(next) {
    mode = next;
    els.tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === next));
    activeCourse = null;
    currentRel = "";
    currentItems = [];
    els.coursePanel.classList.add("hidden");
    els.emptyState.classList.remove("hidden");
    els.search.value = "";
    hideProgress();
    if (next === "remote") await loadRemoteCourses();
    else await loadLocalCourses();
  }

  // Events
  els.search.addEventListener("input", renderCourses);
  els.reload.addEventListener("click", async () => {
    await detectServer();
    if (mode === "remote") loadRemoteCourses();
    else loadLocalCourses();
  });

  els.tabs.forEach((tab) => {
    tab.addEventListener("click", () => switchMode(tab.dataset.tab));
  });

  els.courseList.addEventListener("click", (e) => {
    const btn = e.target.closest(".course-item");
    if (!btn) return;
    const course = courses.find((c) => c.rel === btn.dataset.rel);
    if (course) selectCourse(course);
  });

  els.fileTree.addEventListener("click", (e) => {
    const open = e.target.closest("[data-open]");
    if (open) {
      openPath(open.getAttribute("data-open"));
      return;
    }
    const sysOpen = e.target.closest("[data-open-sys]");
    if (sysOpen) {
      const rel = sysOpen.getAttribute("data-open-sys");
      toast("正在用系统应用打开…");
      fetch(`${apiBase()}/api/open`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rel }),
      })
        .then((r) => r.json())
        .then((j) => {
          if (j.error) toast(j.error);
          else toast("已打开");
        })
        .catch((err) => toast(err.message || "打开失败"));
      return;
    }
    const dl = e.target.closest("[data-dl]");
    if (dl) {
      startDownload(dl.getAttribute("data-dl"), dl.getAttribute("data-name"), "file");
      return;
    }
    const view = e.target.closest("[data-view]");
    if (view) {
      viewLocal(view.getAttribute("data-view"), view.getAttribute("data-name"));
    }
  });

  els.breadcrumbs.addEventListener("click", (e) => {
    const open = e.target.closest("[data-open]");
    if (open) openPath(open.getAttribute("data-open"));
  });

  els.btnDownload.addEventListener("click", () => {
    if (!activeCourse || els.btnDownload.disabled) return;
    const kind = els.btnDownload.dataset.mode === "update" ? "update" : "tree";
    startDownload(activeCourse.rel, activeCourse.name, kind);
  });

  els.btnFolder.addEventListener("click", () => {
    if (!currentRel) return;
    const name = currentRel.split("/").pop();
    const zipRoot = activeCourse ? `${activeCourse.name}/${currentRel.split("/").slice(1).join("/")}` || name : name;
    startDownload(currentRel, zipRoot.includes("/") ? zipRoot : name, "tree");
  });

  els.btnOpenLocal.addEventListener("click", async () => {
    if (!activeCourse || !server) return;
    const rel = activeCourse.rel;
    try {
      const res = await fetch(`${apiBase()}/api/open-folder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rel }),
      });
      const j = await res.json();
      if (j.error) toast(j.error);
      else toast("已打开本地文件夹");
    } catch (err) {
      toast(err.message || "打开失败");
    }
  });

  function openFullApp() {
    window.open(LOCAL_HINT, "_blank", "noopener");
    toast("若未启动，请先运行 start.bat 或 python server.py", 4000);
  }

  document.getElementById("btn-open-full")?.addEventListener("click", openFullApp);
  document.getElementById("btn-open-full-2")?.addEventListener("click", openFullApp);

  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== els.search) {
      e.preventDefault();
      els.search.focus();
      els.search.select();
    }
    if (e.key === "Escape" && document.activeElement === els.search) {
      els.search.blur();
    }
  });

  (async () => {
    await detectServer();
    await switchMode("remote");
  })();
})();
