// ==UserScript==
// @name         WebComics Ripper
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  Download all chapter images from WebComicsApp into a named folder using GM_download
// @author       ozler365
// @license      GPL-3.0-only
// @icon         https://is1-ssl.mzstatic.com/image/thumb/PurpleSource211/v4/c0/87/41/c08741e4-bfca-c565-e3e6-3ba1d5ccd853/Placeholder.mill/400x400bb-75.webp
// @match        https://www.webcomicsapp.com/view/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        unsafeWindow
// @connect      *
// @downloadURL https://update.greasyfork.org/scripts/562787/WebComics%20Ripper.user.js
// @updateURL https://update.greasyfork.org/scripts/562787/WebComics%20Ripper.meta.js
// ==/UserScript==

(function () {
  'use strict';

  /* ─────────────────────────────────────────────
     STATE
  ───────────────────────────────────────────── */
  let capturedPages = null;
  let chapterTitle  = '';
  let isDownloading = false;

  /* ─────────────────────────────────────────────
     XHR INTERCEPT
  ───────────────────────────────────────────── */
  const OrigXHR = unsafeWindow.XMLHttpRequest;
  unsafeWindow.XMLHttpRequest = function () {
    const xhr  = new OrigXHR();
    const open = xhr.open.bind(xhr);
    xhr.open = function (method, url, ...rest) {
      if (url && url.includes('detail?manga_id=')) {
        xhr.addEventListener('load', function () {
          try {
            const json  = JSON.parse(xhr.responseText);
            const pages = json?.data?.pages;
            if (Array.isArray(pages) && pages.length) {
              capturedPages = pages;
              updateButton('ready');
              showToast(`✓ ${pages.length} pages captured — ready!`);
            }
          } catch (_) {}
        });
      }
      return open(method, url, ...rest);
    };
    return xhr;
  };

  /* ─────────────────────────────────────────────
     FETCH INTERCEPT
  ───────────────────────────────────────────── */
  const origFetch = unsafeWindow.fetch;
  unsafeWindow.fetch = async function (input, init, ...rest) {
    const url = typeof input === 'string' ? input : input?.url;
    const res  = await origFetch(input, init, ...rest);
    if (url && url.includes('detail?manga_id=')) {
      try {
        const json  = await res.clone().json();
        const pages = json?.data?.pages;
        if (Array.isArray(pages) && pages.length) {
          capturedPages = pages;
          updateButton('ready');
          showToast(`✓ ${pages.length} pages captured — ready!`);
        }
      } catch (_) {}
    }
    return res;
  };

  /* ─────────────────────────────────────────────
     FALLBACK: call the API directly
  ───────────────────────────────────────────── */
  function fetchDirectly() {
    return new Promise(resolve => {
      const match = location.pathname.match(/\/([a-f0-9]{24})/i)
                 || location.href.match(/manga_id=([a-f0-9]{24})/i);
      if (!match) return resolve(false);

      const mangaId  = match[1];
      const endpoint = `https://api.webcomicsapp.com/api/v1/chapter/detail?manga_id=${mangaId}`;

      GM_xmlhttpRequest({
        method : 'GET',
        url    : endpoint,
        headers: {
          'Referer'     : location.href,
          'Origin'      : 'https://www.webcomicsapp.com',
          'Content-Type': 'application/json',
        },
        onload(r) {
          try {
            const json  = JSON.parse(r.responseText);
            const pages = json?.data?.pages;
            if (Array.isArray(pages) && pages.length) {
              capturedPages = pages;
              return resolve(true);
            }
          } catch (_) {}
          resolve(false);
        },
        onerror() { resolve(false); },
      });
    });
  }

  /* ─────────────────────────────────────────────
     DOWNLOAD — individual GM_download per image
     Files land at: Downloads/<folderName>/001.jpg
  ───────────────────────────────────────────── */
  async function downloadChapter() {
    if (isDownloading) return;

    if (!capturedPages) {
      showToast('⏳ Fetching page list…');
      const ok = await fetchDirectly();
      if (!ok) {
        showToast('❌ Could not get page data. Browse to a chapter page first, then retry.');
        return;
      }
    }

    isDownloading = true;
    const folder = sanitize(chapterTitle || document.title || 'webcomic-chapter');
    const sorted = [...capturedPages].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const total  = sorted.length;

    updateButton('downloading', 0, total);
    showToast(`⬇️ Starting ${total} downloads into "${folder}/"…`);

    let done   = 0;
    let errors = 0;

    // Queue downloads with a small stagger to avoid browser throttling
    for (let i = 0; i < total; i++) {
      const page   = sorted[i];
      const imgUrl = page.url || page.image_url || page.img_url || page.src;
      if (!imgUrl) { errors++; done++; updateButton('downloading', done, total); continue; }

      const ext  = (imgUrl.split('?')[0].match(/\.(jpe?g|png|webp|gif)$/i) || ['', 'jpg'])[1];
      const name = `${folder}/${String(i + 1).padStart(3, '0')}.${ext}`;

      // Each image is a separate browser download saved to Downloads/<folder>/
      await triggerDownload(imgUrl, name);

      done++;
      updateButton('downloading', done, total);

      // Small delay every 5 files so the browser doesn't get overwhelmed
      if (done % 5 === 0) await sleep(300);
    }

    const msg = errors
      ? `⚠️ Done — ${total - errors}/${total} started (${errors} skipped)`
      : `✅ All ${total} images queued → Downloads/${folder}/`;
    showToast(msg, 6000);
    isDownloading = false;
    updateButton('ready');
  }

  /* Wrap GM_download in a Promise so we can await each file */
  function triggerDownload(url, filename) {
    return new Promise(resolve => {
      GM_download({
        url,
        name     : filename,
        saveAs   : false,           // no "Save As" dialog per file
        headers  : { 'Referer': 'https://www.webcomicsapp.com/' },
        onload   : () => resolve(true),
        onerror  : () => resolve(false),
        ontimeout: () => resolve(false),
      });
    });
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /* ─────────────────────────────────────────────
     UI — FLOATING PANEL
  ───────────────────────────────────────────── */
  let btn, progressBar, progressText, statusDot;

  function buildUI() {
    const style = document.createElement('style');
    style.textContent = `
      #wcDL-panel {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 2147483647;
        font-family: 'Segoe UI', system-ui, sans-serif;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 8px;
        pointer-events: none;
      }
      #wcDL-toast {
        background: #12121f;
        color: #dde0ff;
        padding: 9px 14px;
        border-radius: 8px;
        font-size: 12px;
        max-width: 290px;
        box-shadow: 0 4px 20px rgba(0,0,0,.6);
        opacity: 0;
        transition: opacity .3s;
        pointer-events: none;
        border: 1px solid rgba(120,100,255,.25);
        line-height: 1.5;
        word-break: break-word;
      }
      #wcDL-toast.visible { opacity: 1; }
      #wcDL-btn {
        pointer-events: all;
        cursor: pointer;
        background: linear-gradient(135deg, #5b30d6, #3060d0);
        color: #fff;
        border: none;
        border-radius: 12px;
        padding: 0;
        width: 210px;
        overflow: hidden;
        box-shadow: 0 6px 24px rgba(70,40,200,.5);
        transition: transform .15s, box-shadow .15s, opacity .2s;
        user-select: none;
      }
      #wcDL-btn:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 10px 32px rgba(70,40,200,.7); }
      #wcDL-btn:active:not(:disabled) { transform: translateY(0); }
      #wcDL-btn:disabled { opacity: .65; cursor: not-allowed; }
      #wcDL-btn-inner {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 16px;
      }
      #wcDL-dot {
        width: 9px; height: 9px;
        border-radius: 50%;
        background: #888;
        flex-shrink: 0;
        transition: background .3s;
      }
      #wcDL-dot.waiting { background: #ffcc44; animation: wcDL-pulse 1.6s infinite; }
      #wcDL-dot.ready   { background: #44ff90; }
      #wcDL-dot.working { background: #44aaff; animation: wcDL-pulse .7s infinite; }
      #wcDL-label {
        flex: 1;
        font-size: 13px;
        font-weight: 600;
        letter-spacing: .01em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #wcDL-icon { font-size: 16px; flex-shrink: 0; }
      #wcDL-progress-wrap {
        height: 3px;
        background: rgba(255,255,255,.12);
        width: 100%;
      }
      #wcDL-bar {
        height: 100%;
        background: linear-gradient(90deg, #88ffcc, #44aaff);
        width: 0%;
        transition: width .25s;
      }
      @keyframes wcDL-pulse { 0%,100%{opacity:1} 50%{opacity:.25} }
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'wcDL-panel';

    const toast = document.createElement('div');
    toast.id = 'wcDL-toast';

    btn = document.createElement('button');
    btn.id = 'wcDL-btn';
    btn.innerHTML = `
      <div id="wcDL-btn-inner">
        <div id="wcDL-dot" class="waiting"></div>
        <span id="wcDL-label">Waiting for pages…</span>
        <span id="wcDL-icon">📥</span>
      </div>
      <div id="wcDL-progress-wrap"><div id="wcDL-bar"></div></div>
    `;

    statusDot    = btn.querySelector('#wcDL-dot');
    progressBar  = btn.querySelector('#wcDL-bar');
    progressText = btn.querySelector('#wcDL-label');

    btn.addEventListener('click', () => { if (!isDownloading) downloadChapter(); });

    panel.appendChild(toast);
    panel.appendChild(btn);
    document.body.appendChild(panel);
  }

  let toastTimer;
  function showToast(msg, duration = 3500) {
    const el = document.getElementById('wcDL-toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('visible'), duration);
  }

  function updateButton(state, done, total) {
    if (!btn) return;
    statusDot.className = '';
    if (state === 'ready') {
      statusDot.classList.add('ready');
      progressText.textContent = `Download ${capturedPages?.length || ''} images`;
      progressBar.style.width  = '0%';
      btn.querySelector('#wcDL-icon').textContent = '📥';
      btn.disabled = false;
    } else if (state === 'downloading') {
      statusDot.classList.add('working');
      const pct = total ? Math.round((done / total) * 100) : 0;
      progressText.textContent = `${done} / ${total} (${pct}%)`;
      progressBar.style.width  = pct + '%';
      btn.querySelector('#wcDL-icon').textContent = '⏳';
      btn.disabled = true;
    } else {
      statusDot.classList.add('waiting');
      progressText.textContent = 'Waiting for pages…';
      progressBar.style.width  = '0%';
      btn.disabled = false;
    }
  }

  /* ─────────────────────────────────────────────
     HELPERS
  ───────────────────────────────────────────── */
  function sanitize(name) {
    return name
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 100) || 'webcomic-chapter';
  }

  function getTitle() {
    return (document.title || '')
      .replace(/\s*[|–—-]\s*WebComics(app)?\.com\s*$/i, '')
      .trim();
  }

  /* ─────────────────────────────────────────────
     INIT
  ───────────────────────────────────────────── */
  function init() {
    buildUI();
    chapterTitle = getTitle();

    // Poll for title settling after SPA render
    let polls = 0;
    const titlePoll = setInterval(() => {
      const t = getTitle();
      if (t) chapterTitle = t;
      if (++polls > 30) clearInterval(titlePoll);
    }, 400);

    // Detect SPA navigation (chapter change)
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl       = location.href;
        capturedPages = null;
        isDownloading = false;
        chapterTitle  = getTitle();
        updateButton('waiting');
        showToast('🔄 New chapter detected — pages will auto-capture');
      }
    }, 800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();