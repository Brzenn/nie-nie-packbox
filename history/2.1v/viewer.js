(function () {
  const params = new URLSearchParams(location.search);
  const rel = params.get("rel") || "";
  const src = params.get("src") || "auto";
  const name = rel.split("/").pop() || rel;
  const ext = (name.split(".").pop() || "").toLowerCase();
  const title = document.getElementById("title");
  const badge = document.getElementById("badge");
  const main = document.getElementById("main");
  const openRaw = document.getElementById("open-raw");

  title.textContent = name;
  title.title = rel;

  const previewBase =
    "/api/preview?rel=" + encodeURIComponent(rel) + "&src=" + encodeURIComponent(src);
  const rawBase =
    "/api/file?rel=" + encodeURIComponent(rel) + "&src=" + encodeURIComponent(src);
  openRaw.href = rawBase;

  const images = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"];
  const videos = ["mp4", "webm", "mov", "m4v", "ogv", "mkv"];
  const audios = ["mp3", "wav", "ogg", "m4a", "flac"];
  const texts = [
    "txt", "csv", "json", "log", "yml", "yaml", "xml",
    "css", "js", "py", "java", "c", "cpp", "h"
  ];
  const office = ["doc", "docx", "ppt", "pptx", "xls", "xlsx", "odt", "odp", "ods", "rtf", "wps"];

  function show(html) {
    main.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---- Markdown 渲染（来自 md-reader 的简化版）----
  function inline(text) {
    // 先抽出内嵌 HTML 标签，避免被转义成可见的 <h1> 这类文本
    var tags = [];
    var s = String(text).replace(/<\/?[a-zA-Z][^>]*>/g, function (m) {
      tags.push(m);
      return "\x00H" + (tags.length - 1) + "\x00";
    });
    s = escapeHtml(s);
    s = s.replace(/`([^`]+)`/g, function (_, c) {
      return "<code>" + c + "</code>";
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, function (_, alt, url) {
      var u = url;
      if (!/^https?:/i.test(url)) {
        var base = rel.split("/").slice(0, -1);
        var p = url.replace(/^\.\//, "");
        u = "/api/preview?rel=" + encodeURIComponent(base.concat(p.split("/")).join("/"));
      }
      return '<img alt="' + alt + '" src="' + u + '" />';
    });
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_, t, u) {
      return (
        '<a href="' +
        (/^https?:/i.test(u) ? u : u) +
        '" target="_blank" rel="noopener">' +
        t +
        "</a>"
      );
    });
    s = s.replace(/\x00H(\d+)\x00/g, function (_, i) {
      return tags[+i] || "";
    });
    return s;
  }

  function isListLine(line) {
    return /^(\s*)([-*+]|\d{1,9}[.)])\s+/.test(line);
  }

  function collectList(lines, start, out) {
    var i = start;
    var ordered = /^\s*\d{1,9}[.)]\s+/.test(lines[i]);
    var items = [];
    while (i < lines.length) {
      var m = lines[i].match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/);
      if (!m) break;
      items.push(m[3]);
      i++;
    }
    var tag = ordered ? "ol" : "ul";
    out.push(
      "<" +
        tag +
        ">" +
        items.map(function (t) {
          return "<li>" + inline(t) + "</li>";
        }).join("") +
        "</" +
        tag +
        ">"
    );
    return i;
  }

  function renderMarkdown(md) {
    var src = String(md).replace(/\r\n?/g, "\n");
    var lines = src.split("\n");
    var out = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (/^\s*$/.test(line)) {
        i++;
        continue;
      }
      var fence = line.match(/^(\s*)(```+|~~~+)\s*([^\s`]*)\s*$/);
      if (fence) {
        var marker = fence[2].charAt(0);
        var buf = [];
        i++;
        while (i < lines.length) {
          if (new RegExp("^\\s*" + marker + "{3,}\\s*$").test(lines[i])) {
            i++;
            break;
          }
          buf.push(lines[i]);
          i++;
        }
        out.push("<pre><code>" + escapeHtml(buf.join("\n")) + "</code></pre>");
        continue;
      }
      var h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (h) {
        var lv = h[1].length;
        out.push("<h" + lv + ">" + inline(h[2]) + "</h" + lv + ">");
        i++;
        continue;
      }
      if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
        out.push("<hr />");
        i++;
        continue;
      }
      if (/^\s{0,3}>/.test(line)) {
        var qbuf = [];
        while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
          qbuf.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
          i++;
        }
        out.push("<blockquote>" + renderMarkdown(qbuf.join("\n")) + "</blockquote>");
        continue;
      }
      if (isListLine(line)) {
        i = collectList(lines, i, out);
        continue;
      }
      var pbuf = [line.trim()];
      i++;
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        !isListLine(lines[i]) &&
        !/^\s{0,3}(#{1,6}\s|>|```|~~~)/.test(lines[i])
      ) {
        pbuf.push(lines[i].trim());
        i++;
      }
      out.push("<p>" + inline(pbuf.join("\n")).replace(/\n/g, "<br />") + "</p>");
    }
    return out.join("\n");
  }

  async function showMarkdown() {
    show('<article class="md" id="md-root">加载 Markdown…</article>');
    try {
      const res = await fetch(previewBase);
      const raw = await res.text();
      var root = document.getElementById("md-root");
      // 若文件本身就是 HTML（资料库里常见），直接渲染，不要再当 Markdown 转义
      if (/^\s*<(?:!DOCTYPE|html|h[1-6]|ul|ol|p|div|section|article|blockquote)\b/i.test(raw)) {
        root.innerHTML = raw;
      } else {
        root.innerHTML = renderMarkdown(raw);
      }
    } catch (e) {
      show(
        '<div class="state">无法读取：' +
          escapeHtml(e.message || e) +
          '<br/><a href="' +
          rawBase +
          '">下载文件</a></div>'
      );
    }
  }

  function showExternalOpen() {
    badge.textContent = "Office / 外部";
    show(
      '<div class="state">' +
        "<p><strong>" +
        escapeHtml(name) +
        "</strong></p>" +
        "<p>此格式不在网页内预览，可直接查看（本机程序）。</p>" +
        '<p><button id="btn-os-open">查看</button> ' +
        '<a href="' +
        rawBase +
        '" download>下载文件</a></p>' +
        "</div>"
    );
    var btn = document.getElementById("btn-os-open");
    if (btn) {
      btn.addEventListener("click", function () {
        btn.disabled = true;
        btn.textContent = "正在打开…";
        fetch("/api/open?rel=" + encodeURIComponent(rel), { method: "POST" })
          .then(function (r) {
            return r.json();
          })
          .then(function (j) {
            if (j.error) {
              alert(j.error);
              btn.disabled = false;
              btn.textContent = "查看";
            } else {
              btn.textContent = "已调用系统程序";
            }
          })
          .catch(function (e) {
            alert(e.message || "打开失败");
            btn.disabled = false;
            btn.textContent = "查看";
          });
      });
    }
  }

  if (!rel) {
    show('<div class="state">缺少 rel 参数</div>');
  } else if (images.indexOf(ext) >= 0) {
    badge.textContent = "图片";
    show('<img src="' + previewBase + '" alt="' + escapeHtml(name) + '" />');
  } else if (ext === "pdf") {
    badge.textContent = "PDF";
    show('<iframe src="' + previewBase + '" title="pdf"></iframe>');
  } else if (videos.indexOf(ext) >= 0) {
    badge.textContent = "视频";
    show('<video src="' + previewBase + '" controls playsinline></video>');
  } else if (audios.indexOf(ext) >= 0) {
    badge.textContent = "音频";
    show('<audio src="' + previewBase + '" controls></audio>');
  } else if (ext === "md" || ext === "markdown") {
    badge.textContent = "Markdown";
    showMarkdown();
  } else if (ext === "html" || ext === "htm") {
    badge.textContent = "网页";
    show('<iframe src="' + previewBase + '" title="html"></iframe>');
  } else if (texts.indexOf(ext) >= 0) {
    badge.textContent = "文本";
    show('<pre class="text">加载中…</pre>');
    fetch(previewBase)
      .then(function (r) {
        return r.text();
      })
      .then(function (t) {
        main.querySelector("pre").textContent = t;
      })
      .catch(function (e) {
        show(
          '<div class="state">' +
            escapeHtml(e.message) +
            '<br/><a href="' +
            rawBase +
            '">下载</a></div>'
        );
      });
  } else if (office.indexOf(ext) >= 0) {
    showExternalOpen();
  } else {
    badge.textContent = "文件";
    showExternalOpen();
  }
})();
