// ==UserScript==
// @name         MetroDreamin' Coordinate Jump v3
// @namespace    metrodreamin
// @version      3.0
// @description  Paste "lat, lng" or a Google Maps URL to fly the MetroDreamin' map there
// @match        https://metrodreamin.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  let cachedMap = null;

  function parseInput(raw) {
    if (!raw) return null;
    const text = raw.replace(/["'“”]/g, '').trim();

    const m = text.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) ||
              text.match(/[?&](?:q|query|ll)=(-?\d+\.\d+),(-?\d+\.\d+)/) ||
              text.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (m) return { lat: +m[1], lng: +m[2] };

    const p = text.match(/(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)/);
    if (p) {
      const a = +p[1], b = +p[2];
      if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lng: b };
      if (Math.abs(b) <= 90 && Math.abs(a) <= 180) return { lat: b, lng: a };
    }
    return null;
  }

  const isMap = o => {
    try {
      return o && typeof o === 'object' &&
        typeof o.flyTo === 'function' &&
        typeof o.getCenter === 'function' &&
        typeof o.getCanvas === 'function';
    } catch (e) { return false; }
  };

  function mapFromValue(v, depth = 0) {
    if (!v || typeof v !== 'object' || depth > 3) return null;
    if (isMap(v)) return v;
    if (isMap(v.current)) return v.current;
    if (depth < 2) {
      let keys = [];
      try { keys = Object.keys(v); } catch (e) {}
      for (const k of keys.slice(0, 40)) {
        let child;
        try { child = v[k]; } catch (e) { continue; }
        const found = mapFromValue(child, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function mapFromFiber(fiber) {
    let hook = fiber.memoizedState;
    let guard = 0;
    while (hook && guard++ < 100) {
      const found = mapFromValue(hook.memoizedState) || mapFromValue(hook);
      if (found) return found;
      hook = hook.next;
    }
    if (fiber.stateNode && !(fiber.stateNode instanceof Node)) {
      const found = mapFromValue(fiber.stateNode);
      if (found) return found;
    }
    if (fiber.memoizedProps) {
      const found = mapFromValue(fiber.memoizedProps);
      if (found) return found;
    }
    return null;
  }

  function findReactFiber(el) {
    const key = Object.keys(el).find(k =>
      k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    return key ? el[key] : null;
  }

  function findMap() {
    if (cachedMap && isMap(cachedMap) && document.contains(cachedMap.getCanvas())) {
      return cachedMap;
    }
    cachedMap = null;

    const canvas = document.querySelector('.mapboxgl-canvas');
    if (!canvas) return null;

    // 1) Walk up the DOM to the nearest React-owned element, then up the fiber tree
    let el = canvas;
    let startFiber = null;
    while (el && !startFiber) {
      startFiber = findReactFiber(el);
      el = el.parentElement;
    }

    let rootFiber = null;
    if (startFiber) {
      let fiber = startFiber;
      let steps = 0;
      while (fiber && steps++ < 200) {
        const found = mapFromFiber(fiber);
        if (found) return (cachedMap = found);
        rootFiber = fiber;
        fiber = fiber.return;
      }
    }

    // 2) Fallback: scan the full React tree from the root
    if (rootFiber) {
      const stack = [rootFiber];
      let count = 0;
      while (stack.length && count++ < 200000) {
        const f = stack.pop();
        const found = mapFromFiber(f);
        if (found) return (cachedMap = found);
        if (f.sibling) stack.push(f.sibling);
        if (f.child) stack.push(f.child);
      }
    }
    return null;
  }
  // ---------- Location pin overlay ----------
  let pinEl = null;
  let pinCleanup = null;

  function clearPin() {
    if (pinCleanup) { pinCleanup(); pinCleanup = null; }
    if (pinEl) { pinEl.remove(); pinEl = null; }
  }

  function showPin(lat, lng, map) {
    clearPin();

    if (!document.getElementById('md-pin-style')) {
      const style = document.createElement('style');
      style.id = 'md-pin-style';
      style.textContent = `
        @keyframes md-pulse {
          0%   { transform: translate(-50%, -50%) scale(0.4); opacity: 0.8; }
          100% { transform: translate(-50%, -50%) scale(2.2); opacity: 0; }
        }`;
      document.head.appendChild(style);
    }

    const container = map.getContainer();
    pinEl = document.createElement('div');
    pinEl.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:5;will-change:transform;';
    pinEl.innerHTML = `
      <div style="position:absolute;left:0;top:0;width:40px;height:40px;border-radius:50%; transform:translate(-50%, -50%);
                  background:rgba(255,59,48,.45);border:2px solid #ff453a;
                  box-shadow:0 0 12px 2px rgba(255,69,58,.8);"></div>
      <svg width="35" height="45" viewBox="-2 -2 28 36"
           style="position:absolute;left:-17.5px;top:-42.5px;overflow:visible;
                  filter:drop-shadow(0 2px 4px rgba(0,0,0,.6));">
        <path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20C24 5.4 18.6 0 12 0z"
              fill="#ff3b30" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>
        <circle cx="12" cy="12" r="4.5" fill="#7a0c0c"/>
      </svg>`;
    container.appendChild(pinEl);

    const update = () => {
      if (!pinEl) return;
      const pt = map.project([lng, lat]);
      pinEl.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
    };

    update();
    map.on('move', update);
    map.on('zoom', update);
    map.on('resize', update);
    map.on('render', update);
    pinCleanup = () => {
      map.off('move', update);
      map.off('zoom', update);
      map.off('resize', update);
      map.off('render', update);
    };
  }
  function createPanel() {
    if (document.getElementById('md-coordinate-jump')) return;

    const panel = document.createElement('div');
    panel.id = 'md-coordinate-jump';
    panel.style.cssText = `position:fixed;bottom:12px;left:12px;z-index:999999;background:#fff;
      border:1px solid #d0d0d0;border-radius:10px;padding:8px;font:12px/1.3 system-ui,sans-serif;
      box-shadow:0 3px 12px rgba(0,0,0,.18);width:300px;`;
    panel.innerHTML = `
      <div id="md-drag-handle" style="display:flex;justify-content:space-between;align-items:center;
                  font-weight:600;margin-bottom:5px;cursor:move;user-select:none;">
        <span>⋮⋮ Coordinate jump</span>
        <button id="md-min" title="Minimize" style="border:0;background:transparent;cursor:pointer;font-size:14px;line-height:1;">–</button>
      </div>
      <input id="md-coord-input" placeholder="Paste coordinates or Google Maps URL"
        style="width:100%;box-sizing:border-box;padding:6px;border:1px solid #bbb;border-radius:6px;">
      <div style="display:flex;gap:6px;margin-top:6px;">
        <button id="md-go" style="flex:1;padding:6px;border:0;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer;">Go</button>
        <button id="md-debug" style="padding:6px 8px;border:1px solid #bbb;border-radius:6px;background:#f3f4f6;cursor:pointer;">Debug</button>
      </div>
      <div id="md-status" style="margin-top:5px;color:#555;"></div>`;
    document.body.appendChild(panel);

    const input = panel.querySelector('#md-coord-input');
    const status = panel.querySelector('#md-status');
          // ---------- Drag, remember position, minimize ----------
    const handle = panel.querySelector('#md-drag-handle');
    const minBtn = panel.querySelector('#md-min');
    const POS_KEY = 'md-coord-panel-pos';
    const MIN_KEY = 'md-coord-panel-min';

    function placePanel(left, top) {
      const maxL = window.innerWidth - panel.offsetWidth;
      const maxT = window.innerHeight - panel.offsetHeight;
      panel.style.left = Math.max(0, Math.min(left, maxL)) + 'px';
      panel.style.top = Math.max(0, Math.min(top, maxT)) + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }

    function setMinimized(min) {
      [...panel.children].slice(1).forEach(el => { el.style.display = min ? 'none' : ''; });
      minBtn.textContent = min ? '+' : '–';
      minBtn.title = min ? 'Expand' : 'Minimize';
      localStorage.setItem(MIN_KEY, min ? '1' : '0');
    }

    try {
      const saved = JSON.parse(localStorage.getItem(POS_KEY));
      if (saved) placePanel(saved.left, saved.top);
    } catch (e) {}
    setMinimized(localStorage.getItem(MIN_KEY) === '1');

    minBtn.addEventListener('click', e => {
      e.stopPropagation();
      setMinimized(localStorage.getItem(MIN_KEY) !== '1');
    });

    handle.addEventListener('pointerdown', e => {
      if (e.target === minBtn) return;
      const rect = panel.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;
      handle.setPointerCapture(e.pointerId);

      const onMove = ev => placePanel(ev.clientX - offsetX, ev.clientY - offsetY);
      const onUp = ev => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        const r = panel.getBoundingClientRect();
        localStorage.setItem(POS_KEY, JSON.stringify({ left: r.left, top: r.top }));
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });

    function go() {
      const c = parseInput(input.value);
      if (!c) { status.textContent = 'Could not read coordinates.'; return; }
      const map = findMap();
      if (!map) { status.textContent = 'Map object not found. Press Debug and check the console.'; return; }
      map.stop();
      map.flyTo({ center: [c.lng, c.lat], zoom: 18, essential: true, duration: 600 });
      showPin(c.lat, c.lng, map);
      status.textContent = `Jumped to ${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}`;
      input.select();
    }

    panel.querySelector('#md-go').onclick = go;
    input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    input.addEventListener('paste', () => setTimeout(go, 50)); // auto-jump on paste

    panel.querySelector('#md-debug').onclick = () => {
      const canvas = document.querySelector('.mapboxgl-canvas');
      let el = canvas, chain = [];
      while (el) {
        chain.push({ tag: el.tagName, cls: el.className, hasFiber: !!findReactFiber(el) });
        el = el.parentElement;
      }
      console.log('[MD debug] canvas found:', !!canvas);
      console.table(chain.slice(0, 12));
      console.log('[MD debug] map:', findMap());
      status.textContent = 'Debug info printed to console (F12).';
    };
  }

  new MutationObserver(createPanel).observe(document.documentElement, { childList: true, subtree: true });
  createPanel();
})();
