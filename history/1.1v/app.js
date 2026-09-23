(() => {
  const API = "https://openlist.truraly.fun";
  const ROOT = "/成贤学院课程攻略共享计划/资料库";

  const els = {
    search: document.getElementById("search"),
    courseList: document.getElementById("course-list"),
    courseCount: document.getElementById("course-count"),
    reload: document.getElementById("reload-courses"),
    viewCourses: document.getElementById("view-courses"),
    viewCourse: document.getElementById("view-course"),
    btnBack: document.getElementById("btn-back"),
    courseTitle: document.getElementById("course-title"),
    courseStats: document.getElementById("course-stats"),
    fileTree: document.getElementById("file-tree"),
    breadcrumbs: document.getElementById("breadcrumbs"),
    progressSheet: document.getElementById("progress-sheet"),
    progressFill: document.getElementById("progress-fill"),
    progressText: document.getElementById("progress-text"),
    toast: document.getElementById("toast"),
  };

  /** @type {{name:string,path:string}[]} */
  let courses = [];
  let activeCourse = null;
  let currentPath = ROOT;
  let currentItems = [];
  let busy = false;

  function toast(msg, ms = 2800) {
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

  function joinPath(parent, name) {
    return parent.replace(/\/$/, "") + "/" + name;
  }

  function relativePath(abs, base) {
    const a = abs.replace(/\\/g, "/");
    const b = base.replace(/\/$/, "");
    if (a === b) return "";
    if (a.startsWith(b + "/")) return a.slice(b.length + 1);
    return a;
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
    const q = query.trim();
    if (!q) return safe;
    try {
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
      return safe.replace(re, (m) => `<mark>${m}</mark>`);
    } catch {
      return safe;
    }
  }

  function sortCourses(list) {
    return [...list].sort((a, b) =>
      a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" })
    );
  }

  async function apiList(path) {
    const all = [];
    let page = 1;
    const perPage = 100;
    for (;;) {
      const res = await fetch(`${API}/api/fs/list`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, page, per_page: perPage }),
      });
      const json = await res.json();
      if (json.code !== 200) throw new Error(json.message || "列表失败");
      const content = json.data?.content || [];
      all.push(...content);
      const total = json.data?.total ?? all.length;
      if (all.length >= total || content.length === 0) break;
      page += 1;
    }
    return all;
  }

  async function apiGet(path) {
    const res = await fetch(`${API}/api/fs/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const json = await res.json();
    if (json.code !== 200) throw new Error(json.message || "获取失败");
    return json.data;
  }

  async function fetchFileBlob(path) {
    const info = await apiGet(path);
    const raw = info.raw_url;
    if (!raw) throw new Error("无下载链接");
    const res = await fetch(raw);
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    return res.blob();
  }

  /** 递归收集文件；单个目录失败不拖垮整包 */
  async function collectFiles(folderPath, onProgress) {
    const out = [];
    const errors = [];
    async function walk(dirPath, relPrefix) {
      let items;
      try {
        items = await apiList(dirPath);
      } catch (err) {
        errors.push({ path: dirPath, message: err.message || String(err) });
        onProgress?.(`跳过目录：${relPrefix || dirPath}`);
        return;
      }
      for (const item of items) {
        const rel = relPrefix ? `${relPrefix}/${item.name}` : item.name;
        const abs = joinPath(dirPath, item.name);
        onProgress?.(`扫描 ${rel}`);
        if (item.is_dir) {
          await walk(abs, rel);
        } else {
          out.push({ rel, abs, name: item.name, size: item.size || 0 });
        }
      }
    }
    await walk(folderPath, "");
    return { files: out, errors };
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

  function setBusy(on) {
    busy = on;
    document.querySelectorAll("[data-dl],[data-zip]").forEach((el) => {
      el.disabled = on;
    });
  }

  async function downloadSingle(path, name) {
    if (busy) return;
    try {
      setBusy(true);
      toast("正在获取下载链接…");
      const blob = await fetchFileBlob(path);
      triggerDownload(blob, name);
      toast(`已下载：${name}`);
    } catch (err) {
      console.error(err);
      toast(err.message || "下载失败");
    } finally {
      setBusy(false);
    }
  }



  async function walkStats(folderPath) {
    let files = 0;
    let dirs = 0;
    let bytes = 0;
    let errors = 0;
    async function walk(dirPath) {
      let items;
      try {
        items = await apiList(dirPath);
      } catch (err) {
        errors += 1;
        console.warn("walkStats", dirPath, err);
        return;
      }
      for (const item of items) {
        if (item.is_dir) {
          dirs += 1;
          await walk(joinPath(dirPath, item.name));
        } else {
          files += 1;
          bytes += item.size || 0;
        }
      }
    }
    await walk(folderPath);
    return { files, dirs, bytes, errors };
  }

  function setProgress(pct, text) {
    els.progressSheet.classList.remove("hidden");
    els.progressFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    if (text) els.progressText.textContent = text;
  }

  function hideProgress() {
    els.progressSheet.classList.add("hidden");
    els.progressFill.style.width = "0%";
    els.progressText.textContent = "准备中…";
  }

  async function downloadTreeAsZip(folderPath, zipRootName) {
    if (busy) return;
    if (typeof JSZip === "undefined") {
      toast("JSZip 未加载，无法打包");
      return;
    }
    setBusy(true);
    try {
      setProgress(2, "扫描目录结构…");
      const { files, errors: walkErrors } = await collectFiles(folderPath, (t) => setProgress(5, t));
      if (!files.length) {
        const detail = walkErrors.length ? `（${walkErrors[0].message}）` : "";
        toast(`该目录下没有可下载文件${detail}`);
        return;
      }

      setProgress(8, `共 ${files.length} 个文件，开始下载打包…`);
      const zip = new JSZip();
      let done = 0;
      let index = 0;
      const concurrency = 3;

      async function worker() {
        while (index < files.length) {
          const i = index++;
          const f = files[i];
          const zipPath = `${zipRootName}/${f.rel}`;
          try {
            setProgress(
              8 + (done / files.length) * 88,
              `下载 ${done + 1}/${files.length} · ${f.name}`
            );
            const blob = await fetchFileBlob(f.abs);
            zip.file(zipPath, blob);
          } catch (err) {
            console.warn("skip", f.abs, err);
            zip.file(
              `${zipPath}.error.txt`,
              `下载失败：${err.message || err}\n源路径：${f.abs}\n`
            );
          }
          done += 1;
        }
      }

      await Promise.all(Array.from({ length: concurrency }, () => worker()));

      setProgress(96, "生成 ZIP…");
      const blob = await zip.generateAsync(
        { type: "blob", compression: "STORE" },
        (meta) => {
          setProgress(96 + meta.percent * 0.04, `压缩 ${meta.percent.toFixed(0)}%`);
        }
      );
      const safeName = zipRootName.replace(/[\\/:*?"<>|]/g, "_");
      triggerDownload(blob, `${safeName}.zip`);
      const skipNote = walkErrors.length ? ` · 跳过 ${walkErrors.length} 个异常目录` : "";
      toast(`已打包：${safeName}.zip（${files.length} 个文件${skipNote}）`);
    } catch (err) {
      console.error(err);
      toast(err.message || "打包失败");
    } finally {
      setBusy(false);
      hideProgress();
    }
  }

  function showCourses() {
    activeCourse = null;
    els.viewCourses.classList.remove("hidden");
    els.viewCourse.classList.add("hidden");
  }

  function showCourseView() {
    els.viewCourses.classList.add("hidden");
    els.viewCourse.classList.remove("hidden");
    window.scrollTo(0, 0);
  }

  function renderCourses() {
    const q = els.search.value.trim().toLowerCase();
    const filtered = courses.filter((c) => !q || c.name.toLowerCase().includes(q));
    els.courseCount.textContent = q
      ? `${filtered.length} / ${courses.length} 门`
      : `${courses.length} 门课程 · 右侧可直接下载`;

    if (!filtered.length) {
      els.courseList.innerHTML = `<div class="list-empty">没有匹配的课程</div>`;
      return;
    }

    els.courseList.innerHTML = filtered
      .map((c) => {
        const name = escapeHtml(c.name);
        // 列表接口可能不带 path，必须用 ROOT + name 拼完整路径
        const fullPath = escapeHtml(joinPath(ROOT, c.name));
        return `
      <div class="row-item${activeCourse?.name === c.name ? " active" : ""}">
        <button type="button" class="row-open" data-open-course="${name}">
          <span class="name">${highlight(c.name, els.search.value.trim())}</span>
          <span class="meta">点击进入目录</span>
        </button>
        <button type="button" class="btn sm primary" data-zip="${fullPath}" data-zip-name="${name}">下载</button>
      </div>`;
      })
      .join("");
  }

  function iconFor(item) {
    if (item.is_dir) return "夹";
    const ext = (item.name.split(".").pop() || "").toLowerCase();
    const map = {
      pdf: "PDF", doc: "DOC", docx: "DOC",
      ppt: "PPT", pptx: "PPT",
      xls: "XLS", xlsx: "XLS",
      zip: "ZIP", rar: "RAR", "7z": "7Z",
      md: "MD", txt: "TXT",
      png: "IMG", jpg: "IMG", jpeg: "IMG", gif: "IMG", webp: "IMG",
    };
    return map[ext] || "FILE";
  }

  function renderTree() {
    if (!currentItems.length) {
      els.fileTree.innerHTML = `<div class="tree-empty">这个文件夹是空的</div>`;
      return;
    }

    const dirs = currentItems.filter((x) => x.is_dir);
    const files = currentItems.filter((x) => !x.is_dir);
    const sorted = [
      ...dirs.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true })),
      ...files.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true })),
    ];

    els.fileTree.innerHTML = sorted
      .map((item) => {
        const abs = joinPath(currentPath, item.name);
        const sizeLabel = item.is_dir ? "文件夹" : formatSize(item.size);
        // 文件夹：右侧「下载」= 整个文件夹打 ZIP；文件：右侧「下载」= 单文件
        const action = item.is_dir
          ? `<button type="button" class="btn sm primary" data-zip="${escapeHtml(abs)}" data-zip-name="${escapeHtml(item.name)}">下载</button>`
          : `<button type="button" class="btn sm primary" data-dl="${escapeHtml(abs)}" data-name="${escapeHtml(item.name)}">下载</button>`;
        // 点名称：文件夹进入；文件无操作
        const namePart = item.is_dir
          ? `<button type="button" class="row-open" data-open="${escapeHtml(abs)}">
               <span class="icon">${escapeHtml(iconFor(item))}</span>
               <span class="label" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
             </button>`
          : `<div class="row-open static">
               <span class="icon">${escapeHtml(iconFor(item))}</span>
               <span class="label" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
             </div>`;
        return `
        <div class="row-item${item.is_dir ? " is-dir" : ""}">
          ${namePart}
          <span class="tree-meta">${sizeLabel}</span>
          ${action}
        </div>`;
      })
      .join("");
  }

  function renderBreadcrumbs() {
    const rel = relativePath(currentPath, ROOT);
    const parts = rel ? rel.split("/") : [];
    let html = `<button type="button" data-open="${escapeHtml(ROOT)}">资料库</button>`;
    let acc = ROOT;
    parts.forEach((p) => {
      acc = joinPath(acc, p);
      html += `<span class="sep">/</span><button type="button" data-open="${escapeHtml(acc)}">${escapeHtml(p)}</button>`;
    });
    els.breadcrumbs.innerHTML = html;
  }

  async function openPath(path) {
    currentPath = path;
    els.fileTree.innerHTML = `<div class="tree-empty">加载中…</div>`;
    renderBreadcrumbs();
    try {
      currentItems = await apiList(path);
      renderTree();
    } catch (err) {
      console.error(err);
      els.fileTree.innerHTML = `<div class="tree-empty">${escapeHtml(err.message || "加载失败")}</div>`;
    }
  }

  async function selectCourse(course) {
    activeCourse = course;
    showCourseView();
    els.courseTitle.textContent = course.name;
    els.courseStats.textContent = "统计中…";
    renderCourses();

    const coursePath = joinPath(ROOT, course.name);
    currentPath = coursePath;
    renderBreadcrumbs();
    els.fileTree.innerHTML = `<div class="tree-empty">加载中…</div>`;

    try {
      currentItems = await apiList(coursePath);
      renderTree();
    } catch (err) {
      console.error(err);
      els.fileTree.innerHTML = `<div class="tree-empty">${escapeHtml(err.message || "加载失败")}</div>`;
    }

    try {
      const stats = await walkStats(coursePath);
      const errNote = stats.errors ? ` · ${stats.errors} 处失败` : "";
      els.courseStats.textContent = `${stats.files} 文件 · ${stats.dirs} 夹 · ${formatSize(stats.bytes)}${errNote}`;
    } catch (err) {
      console.error(err);
      els.courseStats.textContent = "无法统计";
    }
  }

  async function loadCourses() {
    els.courseList.innerHTML = `<div class="list-empty">加载课程列表…</div>`;
    els.courseCount.textContent = "加载中…";
    try {
      const items = await apiList(ROOT);
      courses = sortCourses(items.filter((x) => x.is_dir));
      renderCourses();
    } catch (err) {
      console.error(err);
      els.courseList.innerHTML = `<div class="list-empty">${escapeHtml(err.message || "加载失败")}</div>`;
      els.courseCount.textContent = "加载失败";
    }
  }

  // Events
  els.search.addEventListener("input", renderCourses);
  els.reload.addEventListener("click", () => loadCourses());
  els.btnBack.addEventListener("click", () => {
    showCourses();
    renderCourses();
  });

  els.courseList.addEventListener("click", (e) => {
    const zipBtn = e.target.closest("[data-zip]");
    if (zipBtn) {
      downloadTreeAsZip(zipBtn.getAttribute("data-zip"), zipBtn.getAttribute("data-zip-name"));
      return;
    }
    const openBtn = e.target.closest("[data-open-course]");
    if (openBtn) {
      const course = courses.find((c) => c.name === openBtn.getAttribute("data-open-course"));
      if (course) selectCourse(course);
    }
  });

  els.fileTree.addEventListener("click", (e) => {
    const zipBtn = e.target.closest("[data-zip]");
    if (zipBtn) {
      downloadTreeAsZip(zipBtn.getAttribute("data-zip"), zipBtn.getAttribute("data-zip-name"));
      return;
    }
    const dl = e.target.closest("[data-dl]");
    if (dl) {
      downloadSingle(dl.getAttribute("data-dl"), dl.getAttribute("data-name"));
      return;
    }
    const open = e.target.closest("[data-open]");
    if (open) {
      openPath(open.getAttribute("data-open"));
    }
  });

  els.breadcrumbs.addEventListener("click", (e) => {
    const open = e.target.closest("[data-open]");
    if (open) openPath(open.getAttribute("data-open"));
  });

  loadCourses();
})();
