(() => {
  const API = "https://openlist.truraly.fun";
  const ROOT = "/成贤学院课程攻略共享计划/资料库";

  const els = {
    search: document.getElementById("search"),
    courseList: document.getElementById("course-list"),
    courseCount: document.getElementById("course-count"),
    reload: document.getElementById("reload-courses"),
    emptyState: document.getElementById("empty-state"),
    coursePanel: document.getElementById("course-panel"),
    courseTitle: document.getElementById("course-title"),
    courseCrumb: document.getElementById("course-crumb"),
    fileStats: document.getElementById("file-stats"),
    sizeStats: document.getElementById("size-stats"),
    fileTree: document.getElementById("file-tree"),
    breadcrumbs: document.getElementById("breadcrumbs"),
    btnZip: document.getElementById("btn-download-zip"),
    btnFolder: document.getElementById("btn-download-folder"),
    progressWrap: document.getElementById("progress-wrap"),
    progressFill: document.getElementById("progress-fill"),
    progressText: document.getElementById("progress-text"),
    toast: document.getElementById("toast"),
  };

  /** @type {{name:string,path:string}[]} */
  let courses = [];
  let activeCourse = null;
  let currentPath = ROOT;
  let currentItems = [];
  let courseStats = { files: 0, dirs: 0, bytes: 0 };
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
    if (!query) return safe;
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

  async function downloadSingle(path, name) {
    try {
      busy = true;
      toast("正在获取下载链接…");
      const blob = await fetchFileBlob(path);
      triggerDownload(blob, name);
      toast(`已下载：${name}`);
    } catch (err) {
      console.error(err);
      toast(err.message || "下载失败");
    } finally {
      busy = false;
    }
  }

  /**
   * Recursively collect all files under a folder path.
   * `rel` is relative to folderPath.
   * @returns {Promise<{rel:string, abs:string, name:string, size:number}[]>}
   */
  async function collectFiles(folderPath, onProgress) {
    const out = [];
    async function walk(dirPath, relPrefix) {
      const items = await apiList(dirPath);
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
    return out;
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
        console.warn("walkStats list failed", dirPath, err);
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
    els.progressWrap.classList.remove("hidden");
    els.progressFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    if (text) els.progressText.textContent = text;
  }

  function hideProgress() {
    els.progressWrap.classList.add("hidden");
    els.progressFill.style.width = "0%";
    els.progressText.textContent = "准备中…";
  }

  /**
   * Pack folderPath into a ZIP whose entries live under zipRootName/.
   * @param {string} folderPath API path of the folder to pack
   * @param {string} zipRootName top-level folder name inside the ZIP
   */
  async function downloadTreeAsZip(folderPath, zipRootName) {
    if (busy) return;
    if (typeof JSZip === "undefined") {
      toast("JSZip 未加载，无法打包");
      return;
    }
    busy = true;
    els.btnZip.disabled = true;
    els.btnFolder.disabled = true;
    try {
      setProgress(2, "扫描目录结构…");
      const files = await collectFiles(folderPath, (t) => setProgress(5, t));
      if (!files.length) {
        toast("该目录下没有文件");
        return;
      }

      setProgress(8, `共 ${files.length} 个文件，开始打包…`);
      const zip = new JSZip();
      let done = 0;
      let index = 0;
      const concurrency = 4;

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
      toast(`已打包下载：${safeName}.zip（${files.length} 个文件）`);
    } catch (err) {
      console.error(err);
      toast(err.message || "打包失败");
    } finally {
      busy = false;
      els.btnZip.disabled = false;
      els.btnFolder.disabled = false;
      hideProgress();
    }
  }

  function renderCourses() {
    const q = els.search.value.trim().toLowerCase();
    const filtered = courses.filter((c) => !q || c.name.toLowerCase().includes(q));
    els.courseCount.textContent = q
      ? `${filtered.length} / ${courses.length} 门课程`
      : `${courses.length} 门课程 · 字母序`;

    if (!filtered.length) {
      els.courseList.innerHTML = `<div class="list-empty">没有匹配的课程</div>`;
      return;
    }

    els.courseList.innerHTML = filtered
      .map(
        (c) => `
      <button type="button" class="course-item${activeCourse?.name === c.name ? " active" : ""}" data-name="${escapeHtml(c.name)}" data-path="${escapeHtml(c.path)}">
        <span class="name">${highlight(c.name, els.search.value.trim())}</span>
        <span class="meta">${escapeHtml(c.path.replace(ROOT + "/", ""))}</span>
      </button>`
      )
      .join("");
  }

  function iconFor(item) {
    if (item.is_dir) return "夹";
    const ext = (item.name.split(".").pop() || "").toLowerCase();
    const map = {
      pdf: "PDF",
      doc: "DOC",
      docx: "DOC",
      ppt: "PPT",
      pptx: "PPT",
      xls: "XLS",
      xlsx: "XLS",
      zip: "ZIP",
      rar: "RAR",
      "7z": "7Z",
      md: "MD",
      txt: "TXT",
      png: "IMG",
      jpg: "IMG",
      jpeg: "IMG",
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
        const action = item.is_dir
          ? `<button type="button" class="btn sm" data-open="${escapeHtml(abs)}">打开</button>`
          : `<button type="button" class="btn sm" data-dl="${escapeHtml(abs)}" data-name="${escapeHtml(item.name)}">下载</button>`;
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
      const isRootOfCourse =
        activeCourse && path === joinPath(ROOT, activeCourse.name);
      els.btnFolder.classList.toggle("hidden", path === ROOT || isRootOfCourse);
    } catch (err) {
      console.error(err);
      els.fileTree.innerHTML = `<div class="tree-empty">${escapeHtml(err.message || "加载失败")}</div>`;
    }
  }

  async function selectCourse(course) {
    activeCourse = course;
    els.emptyState.classList.add("hidden");
    els.coursePanel.classList.remove("hidden");
    els.courseTitle.textContent = course.name;
    els.courseCrumb.textContent = course.name;
    els.fileStats.textContent = "统计中…";
    els.sizeStats.textContent = "";
    renderCourses();

    const coursePath = joinPath(ROOT, course.name);
    currentPath = coursePath;
    renderBreadcrumbs();
    els.fileTree.innerHTML = `<div class="tree-empty">加载中…</div>`;
    els.btnFolder.classList.add("hidden");

    try {
      const items = await apiList(coursePath);
      currentItems = items;
      renderTree();
    } catch (err) {
      console.error(err);
      els.fileTree.innerHTML = `<div class="tree-empty">${escapeHtml(err.message || "加载失败")}</div>`;
    }

    try {
      courseStats = await walkStats(coursePath);
      const errNote = courseStats.errors ? ` · ${courseStats.errors} 处读取失败` : "";
      els.fileStats.textContent = `${courseStats.files} 个文件 · ${courseStats.dirs} 个子文件夹${errNote}`;
      els.sizeStats.textContent = formatSize(courseStats.bytes);
    } catch (err) {
      console.error(err);
      els.fileStats.textContent = "无法统计";
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

  els.courseList.addEventListener("click", (e) => {
    const btn = e.target.closest(".course-item");
    if (!btn) return;
    const course = courses.find((c) => c.name === btn.dataset.name);
    if (course) selectCourse(course);
  });

  els.fileTree.addEventListener("click", (e) => {
    const open = e.target.closest("[data-open]");
    if (open) {
      openPath(open.getAttribute("data-open"));
      return;
    }
    const dl = e.target.closest("[data-dl]");
    if (dl) {
      downloadSingle(dl.getAttribute("data-dl"), dl.getAttribute("data-name"));
    }
  });

  els.breadcrumbs.addEventListener("click", (e) => {
    const open = e.target.closest("[data-open]");
    if (open) openPath(open.getAttribute("data-open"));
  });

  els.btnZip.addEventListener("click", () => {
    if (!activeCourse) return;
    downloadTreeAsZip(joinPath(ROOT, activeCourse.name), activeCourse.name);
  });

  els.btnFolder.addEventListener("click", () => {
    if (!activeCourse || currentPath === ROOT) return;
    const rel = relativePath(currentPath, joinPath(ROOT, activeCourse.name));
    const zipRoot = rel ? `${activeCourse.name}/${rel}` : activeCourse.name;
    downloadTreeAsZip(currentPath, zipRoot);
  });

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

  loadCourses();
})();
