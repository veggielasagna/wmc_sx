/* WMC SX — interface logic.
   Talks to the native app through window.chrome.webview (see MainPage.xaml.cs).
   When opened in a normal browser it loads mock.js so the UI can be tried out. */
'use strict';

(function () {
  const native = window.chrome && window.chrome.webview ? window.chrome.webview : null;
  const stage = document.getElementById('stage');
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ================================================================ Storage */
  const Store = {
    get(k, d) {
      try { const v = localStorage.getItem('wmcsx.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set(k, v) {
      try { localStorage.setItem('wmcsx.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ }
    }
  };
  const prefs = Object.assign({ sound: true, resume: true, intro: true }, Store.get('prefs', {}));
  const savePrefs = () => Store.set('prefs', prefs);

  /* ================================================================ Bridge to the native app */
  const Bridge = {
    seq: 0,
    pending: new Map(),
    handlers: {},
    call(cmd, args) {
      if (!native) return window.WmcMock.call(cmd, args || {});
      return new Promise((resolve, reject) => {
        const id = ++this.seq;
        this.pending.set(id, { resolve, reject });
        native.postMessage({ id: id, cmd: cmd, args: args || {} });
        const limit = cmd === 'usbScan' ? 600000 : 45000;
        setTimeout(() => {
          if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('No answer (' + cmd + ')')); }
        }, limit);
      });
    },
    on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
    emit(ev, data) {
      (this.handlers[ev] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } });
    }
  };
  window.WmcBridge = Bridge;
  // Send interface errors to the native log (LocalState\wmcsx_log.txt).
  const nativeLog = text => { if (native) { try { native.postMessage({ id: 0, cmd: 'log', args: { text: String(text).slice(0, 2000) } }); } catch (e) { /* ignore */ } } };
  window.addEventListener('error', e => nativeLog('error: ' + e.message + ' at ' + (e.filename || '') + ':' + (e.lineno || 0)));
  window.addEventListener('unhandledrejection', e => nativeLog('unhandled promise: ' + (e.reason && e.reason.message ? e.reason.message : e.reason)));
  if (native) {
    native.addEventListener('message', e => {
      const m = e.data;
      if (!m) return;
      if (m.id) {
        const p = Bridge.pending.get(m.id);
        if (!p) return;
        Bridge.pending.delete(m.id);
        if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error || 'Something went wrong'));
      } else if (m.event) {
        Bridge.emit(m.event, m.data);
      }
    });
  }

  /* ================================================================ Media URLs and artwork */
  // size: longest side in pixels for tiles and artwork. The app shrinks big pictures to that
  // and keeps them on the console, so grids scroll smoothly and load instantly next time.
  function mediaUrl(u, size) {
    if (!u) return '';
    if (u.indexOf('usbthumb:') === 0) return native ? 'https://media.wmcsx/usbthumb?p=' + encodeURIComponent(u.slice(9)) : '';
    if (u.indexOf('usb:') === 0) return native ? (size ? 'https://media.wmcsx/usbthumb?p=' : 'https://full.wmcsx/usbfile?p=') + encodeURIComponent(u.slice(4)) : '';
    if (!native) return u;
    // Full-size pictures use their own address so they never queue behind tiles.
    return (size ? 'https://media.wmcsx/img?u=' : 'https://full.wmcsx/img?u=') + encodeURIComponent(u) + (size ? '&s=' + size : '');
  }
  const GRADS = ['#F7B25A,#A8480E', '#E8806A,#7A2420', '#D9A066,#6A3A1A', '#F2C27A,#B0641A', '#C9786A,#5A2230', '#E6A15C,#8A3A12', '#B98A9E,#4A2238', '#E0B08A,#7A4428', '#F09A72,#9A3A1E', '#C9A070,#5A3A22'];
  function hash(s) { let h = 0; s = String(s || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
  const ART_SIZE = 480;
  const gradOf = seed => 'linear-gradient(135deg,' + Theme.grads[hash(seed) % Theme.grads.length] + ')';

  /* ================================================================ Colour themes */
  // Every colour in app.css is a variable (--t0, --t1, …) holding the Ember values. A theme turns
  // the whole set around the colour wheel and adjusts its strength, so the glass, edges, glows and
  // text tints keep the same relationships in every theme.
  const THEMES = [
    { id: 'ember', name: 'Ember', hue: 0, sat: 1, light: 1 },
    { id: 'aero', name: 'Aero Blue', hue: 190, sat: 0.95, light: 1.06 },
    { id: 'lagoon', name: 'Lagoon', hue: 158, sat: 0.85, light: 1.02 },
    { id: 'emerald', name: 'Emerald', hue: 112, sat: 0.78, light: 1 },
    { id: 'gold', name: 'Gold', hue: 18, sat: 1, light: 1.03 },
    { id: 'rose', name: 'Rose', hue: -30, sat: 0.92, light: 1.03 },
    { id: 'amethyst', name: 'Amethyst', hue: -100, sat: 0.85, light: 1.07 },
    { id: 'graphite', name: 'Graphite', hue: 190, sat: 0.1, light: 1.02 }
  ];
  const Theme = {
    base: null, grads: GRADS, current: 'ember',
    rgbToHsl(r, g, b) {
      r /= 255; g /= 255; b /= 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
      if (mx === mn) return [0, 0, l];
      const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return [h * 60, s, l];
    },
    hslToRgb(h, s, l) {
      h = ((h % 360) + 360) % 360 / 360;
      if (!s) { const v = Math.round(l * 255); return [v, v, v]; }
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
      const f = t => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
      return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map(v => Math.round(v * 255));
    },
    shift(rgb, t) {
      const hsl = this.rgbToHsl(rgb[0], rgb[1], rgb[2]);
      return this.hslToRgb(hsl[0] + t.hue, Math.min(1, hsl[1] * t.sat), Math.min(1, hsl[2] * t.light));
    },
    hex(rgb) { return '#' + rgb.map(v => ('0' + v.toString(16)).slice(-2)).join(''); },
    readBase() {
      if (this.base) return this.base;
      const cs = getComputedStyle(document.documentElement), out = [];
      for (let i = 0; ; i++) {
        const v = cs.getPropertyValue('--t' + i).trim();
        if (!v) break;
        out.push(v.split(',').map(Number));
      }
      return (this.base = out);
    },
    byId(id) { return THEMES.find(t => t.id === id) || THEMES[0]; },
    // A few of the theme's own colours, for the swatches in Settings.
    preview(t) {
      const f = h => this.hex(this.shift([parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)], t));
      return { bg1: f('#4A1A1C'), bg2: f('#250B12'), glow: f('#7A2E1C'), cap1: f('#F7B25A'), cap2: f('#B85A12'), focus: f('#FFC870') };
    },
    apply(id) {
      const t = this.byId(id);
      this.current = t.id;
      const base = this.readBase(), root = document.documentElement.style;
      base.forEach((c, i) => {
        const v = t.id === 'ember' ? c : this.shift(c, t);
        root.setProperty('--t' + i, v.join(','));
      });
      root.setProperty('--ribbon', this.shift([255, 216, 168], t).join(','));
      this.grads = GRADS.map(pair => pair.split(',').map(h => this.hex(this.shift([parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)], t))).join(','));
      // The app shows this colour before the interface has loaded, so the next start matches.
      const bg = this.hex(this.shift([20, 6, 11], t));
      if (native) Bridge.call('theme', { background: bg }).catch(() => {});
      return t;
    }
  };
  function artBg(art, seed) {
    const g = gradOf(seed);
    const u = mediaUrl(art, ART_SIZE);
    // Single quotes: this text goes inside style="..." attributes, where a double quote would end the attribute.
    return u ? "background-image:url('" + u.replace(/'/g, '%27').replace(/"/g, '%22').replace(/[()\s]/g, c => encodeURIComponent(c)) + "')," + g : 'background-image:' + g;
  }
  // Grids and lists can hold thousands of pictures. The browser keeps every picture it has ever
  // shown (as CSS background or <img>) in its own cache and only lets go when it notices memory is
  // short, which it never does on Xbox, so scrolling a big photo folder ran the app out of memory.
  // So list pictures are drawn into a small <canvas> instead: fetched, decoded with
  // createImageBitmap, drawn, and the decoded copy closed straight away. When the item scrolls far
  // away the canvas is emptied, which really frees the memory. lazyArt() draws only the colour
  // gradient; watchArt() adds and removes the pictures as items come near or go far.
  function lazyArt(art, seed) {
    const g = gradOf(seed), u = mediaUrl(art, ART_SIZE);
    return 'style="background-image:' + g + '"' + (u ? ' data-art="' + esc(u) + '"' : '');
  }
  const ART_MARGIN = '600px 0px';
  function showArt(el) {
    if (el._art) return;
    const job = el._art = { abort: window.AbortController ? new AbortController() : null };
    fetch(el.dataset.art, job.abort ? { signal: job.abort.signal } : undefined)
      .then(r => r.ok ? r.blob() : null)
      .then(b => b ? createImageBitmap(b) : null)
      .then(bm => {
        if (!bm) return;
        if (el._art !== job || !el.isConnected) { bm.close(); return; }
        const W = Math.max(1, Math.round(el.clientWidth)), H = Math.max(1, Math.round(el.clientHeight));
        const c = document.createElement('canvas');
        c.className = 'pic';
        c.width = W; c.height = H;
        // Fill the space like background-size: cover.
        const k = Math.max(W / bm.width, H / bm.height), w = bm.width * k, h = bm.height * k;
        c.getContext('2d').drawImage(bm, (W - w) / 2, (H - h) / 2, w, h);
        bm.close();
        job.canvas = c;
        el.appendChild(c);
      })
      .catch(() => { /* picture not available: the gradient stays */ });
  }
  function hideArt(el) {
    const job = el._art;
    if (!job) return;
    el._art = null;
    if (job.abort) { try { job.abort.abort(); } catch (e) { /* ignore */ } }
    if (job.canvas) { job.canvas.width = 0; job.canvas.height = 0; job.canvas.remove(); }
  }
  const artWatchers = new Map(); // scroll box (or null for the page) -> { io, els }
  function artObserver(box) {
    let w = artWatchers.get(box);
    if (w) return w;
    const io = new IntersectionObserver(entries => entries.forEach(e => {
      if (e.isIntersecting) showArt(e.target); else hideArt(e.target);
    }), { root: box, rootMargin: ART_MARGIN });
    w = { io: io, els: new Set() };
    artWatchers.set(box, w);
    return w;
  }
  let artScan = 0;
  function watchArt() {
    artScan = 0;
    // Stop watching pictures that left the screen, and scroll boxes that are gone.
    artWatchers.forEach((w, box) => {
      w.els.forEach(el => { if (!el.isConnected) { w.io.unobserve(el); w.els.delete(el); hideArt(el); } });
      if (box && !box.isConnected) { w.io.disconnect(); artWatchers.delete(box); }
    });
    document.querySelectorAll('[data-art]:not([data-aw])').forEach(el => {
      el.setAttribute('data-aw', '');
      const w = artObserver(el.closest('.content'));
      w.io.observe(el); w.els.add(el);
    });
  }
  new MutationObserver(() => { if (!artScan) artScan = requestAnimationFrame(watchArt); })
    .observe(document.documentElement, { childList: true, subtree: true });

  function fmtTime(s) {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
  }

  /* ================================================================ Icons */
  const ICONS = {
    grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
    folder: '<path d="M3 7.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    usb: '<rect x="7" y="9" width="10" height="12" rx="2"/><path d="M9 9V3.5h6V9"/>',
    play: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10 9.5l5 2.5-5 2.5z"/>',
    resume: '<circle cx="12" cy="12" r="8.5"/><path d="M10 9l5 3-5 3z"/>',
    photo: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M4 17l5-4.5 4 3.5 3-2.5 4 3.5"/>',
    gear: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    server: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 10h8"/><circle cx="12" cy="16" r="1.2"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h0"/>',
    note: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
    person: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1-4 4-6 7-6s6 2 7 6"/>',
    tag: '<path d="M3 12V4h8l9 9-8 8z"/><circle cx="7.5" cy="8.5" r="1.3"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
    palette: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.3-1.1-1.6-1.1-2.8 0-1 .8-1.7 1.9-1.7h2.1c2.4 0 3.8-1.6 3.8-3.8C20.5 6.6 16.7 3.5 12 3.5z"/><circle cx="7.6" cy="11" r="1.2"/><circle cx="10" cy="7.4" r="1.2"/><circle cx="14.6" cy="7.4" r="1.2"/>'
  };
  const ico = (name, cls) => '<svg class="' + (cls || 'ico') + '" viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  const SVG = {
    play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zM20 5v14l-11-7z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg>',
    shuffle: '<svg class="s" viewBox="0 0 24 24"><path d="M3 7h3c4 0 6 10 10 10h4M17 14l3 3-3 3M3 17h3c1.5 0 2.7-1.4 3.7-3M14.3 10C15.3 8.4 16.5 7 18 7h2M17 4l3 3-3 3"/></svg>',
    repeat: '<svg class="s" viewBox="0 0 24 24"><path d="M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4"/></svg>',
    repeatOne: '<svg class="s" viewBox="0 0 24 24"><path d="M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4M11.5 10.5l1.5-1v5"/></svg>'
  };

  /* ================================================================ Sounds (soft glassy chimes) */
  const Sfx = {
    ac: null,
    bus: null,
    play(kind, n) {
      if (!prefs.sound) return;
      // Quiet while music is playing, so the chimes don't play over the song.
      if (P.state === 'playing') return;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        if (!this.ac) this.ac = new AC();
        const ac = this.ac;
        if (ac.state === 'suspended') ac.resume();
        if (!this.bus) {
          const soft = ac.createBiquadFilter(); soft.type = 'lowpass'; soft.frequency.value = 1400; soft.Q.value = 0.3;
          const master = ac.createGain(); master.gain.value = 0.7;
          soft.connect(master); master.connect(ac.destination);
          const delay = ac.createDelay(1); delay.delayTime.value = 0.21;
          const fb = ac.createGain(); fb.gain.value = 0.35;
          const wetTone = ac.createBiquadFilter(); wetTone.type = 'lowpass'; wetTone.frequency.value = 900;
          const wet = ac.createGain(); wet.gain.value = 0.45;
          soft.connect(delay); delay.connect(wetTone); wetTone.connect(fb); fb.connect(delay); wetTone.connect(wet); wet.connect(master);
          this.bus = soft;
        }
        const chord = [440.0, 554.37, 659.25, 830.61, 987.77];
        let notes, vol = 0.035;
        const gap = 0.07;
        if (kind === 'move') notes = [chord[(n || 0) % 5]];
        else if (kind === 'tick') { notes = [chord[(n || 0) % 5] * 1.5]; vol = 0.009; }
        else if (kind === 'select') { notes = [440.0, 554.37, 659.25]; vol = 0.03; }
        else if (kind === 'back') { notes = [659.25, 554.37, 440.0]; vol = 0.03; }
        else notes = [554.37];
        const t0 = ac.currentTime + 0.02;
        notes.forEach((f, i) => {
          const t = t0 + i * gap;
          [[1, 1], [1.5, 0.12], [2, 0.08]].forEach(pr => {
            const o = ac.createOscillator(), g = ac.createGain();
            o.type = 'sine';
            o.frequency.setValueAtTime(f * pr[0] * 0.985, t);
            o.frequency.exponentialRampToValueAtTime(f * pr[0], t + 0.06);
            const v = vol * pr[1];
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(v, t + 0.045);
            g.gain.exponentialRampToValueAtTime(v * 0.4, t + 0.25);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
            o.connect(g); g.connect(this.bus);
            o.start(t); o.stop(t + 1.35);
          });
        });
      } catch (e) { /* audio unavailable */ }
    }
  };


  /* ================================================================ Startup animation and sound */
  // An original warm chord swell with a soft whoosh and rising glass chimes (about 6 seconds).
  function introSound() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!Sfx.ac) Sfx.ac = new AC();
      const ac = Sfx.ac;
      if (ac.state === 'suspended') ac.resume();
      const t0 = ac.currentTime + 0.05;

      const master = ac.createGain();
      master.gain.setValueAtTime(0.0001, t0);
      master.gain.exponentialRampToValueAtTime(0.85, t0 + 0.8);
      master.gain.setValueAtTime(0.85, t0 + 4.3);
      master.gain.exponentialRampToValueAtTime(0.0001, t0 + 6.6);
      master.connect(ac.destination);

      // Soft echo "room".
      const room = ac.createGain(); room.gain.value = 0.55;
      [0.13, 0.29, 0.47].forEach((d, i) => {
        const dl = ac.createDelay(1); dl.delayTime.value = d;
        const fb = ac.createGain(); fb.gain.value = 0.38 - i * 0.08;
        const tone = ac.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = 1700 - i * 400;
        room.connect(dl); dl.connect(tone); tone.connect(fb); fb.connect(dl); tone.connect(master);
      });

      // Warm pad that opens up like light coming in.
      const padFilter = ac.createBiquadFilter();
      padFilter.type = 'lowpass'; padFilter.Q.value = 0.6;
      padFilter.frequency.setValueAtTime(260, t0);
      padFilter.frequency.exponentialRampToValueAtTime(2400, t0 + 3.2);
      padFilter.frequency.exponentialRampToValueAtTime(1400, t0 + 6.4);
      padFilter.connect(master); padFilter.connect(room);
      const pad = (notes, start, end, level) => {
        notes.forEach(f => {
          [[-5, 'sine'], [5, 'triangle']].forEach(v => {
            const o = ac.createOscillator(), g = ac.createGain();
            o.type = v[1]; o.frequency.value = f; o.detune.value = v[0];
            g.gain.setValueAtTime(0.0001, start);
            g.gain.exponentialRampToValueAtTime(level, start + 1.3);
            g.gain.setValueAtTime(level, end - 1.2);
            g.gain.exponentialRampToValueAtTime(0.0001, end);
            o.connect(g); g.connect(padFilter);
            o.start(start); o.stop(end + 0.05);
          });
        });
      };
      pad([73.42, 146.83, 220.0, 277.18, 329.63, 369.99], t0 + 0.1, t0 + 3.4, 0.022);   // D major 9
      pad([98.0, 196.0, 246.94, 293.66, 369.99, 440.0], t0 + 2.6, t0+ 6.5, 0.02);      // G major 9

      // Airy whoosh as the sky blooms.
      const len = Math.floor(ac.sampleRate * 2.2);
      const buf = ac.createBuffer(1, len, ac.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
      const noise = ac.createBufferSource(); noise.buffer = buf;
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.4;
      bp.frequency.setValueAtTime(350, t0); bp.frequency.exponentialRampToValueAtTime(3200, t0 + 1.8);
      const ng = ac.createGain();
      ng.gain.setValueAtTime(0.0001, t0); ng.gain.exponentialRampToValueAtTime(0.06, t0 + 0.9); ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.1);
      noise.connect(bp); bp.connect(ng); ng.connect(master); ng.connect(room);
      noise.start(t0); noise.stop(t0 + 2.2);

      // Glass chimes rising as the orb appears, then a sparkle under the title.
      const bell = (f, t, level) => {
        [[1, 1], [2.01, 0.28], [3.02, 0.12]].forEach(p => {
          const o = ac.createOscillator(), g = ac.createGain();
          o.type = 'sine'; o.frequency.value = f * p[0];
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(level * p[1], t + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8 / p[0]);
          o.connect(g); g.connect(master); g.connect(room);
          o.start(t); o.stop(t + 2);
        });
      };
      [587.33, 739.99, 880.0, 1108.73, 1318.51].forEach((f, i) => bell(f, t0 + 1.05 + i * 0.12, 0.045));
      [1174.66, 1479.98, 1760.0].forEach((f, i) => bell(f, t0 + 2.55 + i * 0.09, 0.03));
      bell(2349.32, t0 + 3.05, 0.018);
      return master;
    } catch (e) {
      return null;
    }
  }

  const Intro = {
    active: false,
    finish: null,
    play() {
      return new Promise(resolve => {
        const el = $('#intro');
        if (!el) { resolve(); return; }
        this.active = true;
        el.classList.remove('hidden', 'out');
        void el.offsetWidth;
        el.classList.add('play');
        const master = introSound();
        let done = false;
        const timer = setTimeout(() => this.finish(), 5600);
        this.finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (master) {
            try {
              const now = Sfx.ac.currentTime;
              master.gain.cancelScheduledValues(now);
              master.gain.setValueAtTime(Math.max(0.0001, master.gain.value), now);
              master.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);
            } catch (e) { /* ignore */ }
          }
          el.classList.add('out');
          setTimeout(() => {
            el.classList.add('hidden');
            el.classList.remove('play', 'out');
            this.active = false;
            resolve();
          }, 900);
        };
      });
    }
  };

  /* ================================================================ Toast */
  let toastTimer = 0;
  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), ms || 3800);
  }
  Bridge.on('toast', m => toast(m));

  /* ================================================================ Library (DLNA server + index) */
  const Lib = {
    server: null,
    servers: new Map(),
    roots: null,
    tracks: [], videos: [], albums: [], artists: [], genres: [],
    albumMap: new Map(),
    building: false,
    progress: '',
    builtAt: 0,
    savedServer: Store.get('server', null),

    addServer(s) {
      if (!s || !s.id) return;
      this.servers.set(s.id, s);
      const saved = this.savedServer;
      if (!this.server && (!saved || saved.id === s.id)) this.select(s, false);
      else if (this.server && this.server.id === s.id) this.server = s;
      refreshIf(['settings']);
    },

    async select(s, userChose) {
      this.server = s;
      this.savedServer = { id: s.id, location: s.location, name: s.name };
      Store.set('server', this.savedServer);
      this.roots = null;
      let data = null;
      try {
        const text = await Bridge.call('loadFile', { name: 'index.json' });
        if (text) data = JSON.parse(text);
      } catch (e) { data = null; }
      if (data && data.server === s.id && data.version === 2) {
        this.apply(data);
        refreshIf(['music', 'videos', 'photos', 'album', 'artist', 'genre', 'settings', 'home']);
        // Refresh quietly in the background if the index is over a day old.
        if (Date.now() - (data.at || 0) > 86400000) this.buildIndex();
      } else {
        this.apply({ tracks: [], videos: [], roots: null, at: 0 });
        refreshIf(['music', 'videos', 'photos', 'settings', 'home']);
        this.buildIndex();
      }
      if (userChose) toast('Connected to ' + s.name);
    },

    // Reads a folder page by page. onPage(items, total, done) is called after each page, so big
    // folders (tens of thousands of photos) can be shown while the rest is still arriving.
    // Returns false from onPage to stop early.
    async browsePages(id, onPage, opts) {
      opts = opts || {};
      const max = opts.max || 200000, size = opts.size || 200;
      let start = 0, got = 0;
      for (let guard = 0; guard < 2000 && got < max; guard++) {
        const r = await Bridge.call('browse', { server: this.server.id, id: id, start: start, count: size });
        const items = (r && r.items) || [];
        const step = Math.max(items.length, (r && r.returned) || 0);
        got += items.length;
        start += step;
        const done = !step || (r.total ? start >= r.total : step < size) || got >= max;
        if (onPage(items, (r && r.total) || got, done) === false || done) break;
      }
    },
    async browseAll(id, max) {
      const out = [];
      await this.browsePages(id, items => { out.push.apply(out, items); }, { max: max || 200000 });
      return out;
    },

    async findRoots() {
      if (this.roots) return this.roots;
      const top = await this.browseAll('0', 200);
      const pick = re => { const c = top.find(x => x.kind === 'container' && re.test(x.title)); return c ? c.id : null; };
      this.roots = {
        music: pick(/music|musik|musique|m[uú]sica|audio/i),
        video: pick(/video|vid[eé]o|movie|film/i),
        photo: pick(/photo|picture|image|pics|bilder|fotos?/i)
      };
      if (!this.roots.music && !this.roots.video && !this.roots.photo) this.roots = { music: '0', video: '0', photo: '0' };
      return this.roots;
    },

    async crawl(rootId, onItem, label) {
      const kids = await this.browseAll(rootId, 1000);
      const folderView = kids.find(k => k.kind === 'container' && /^(folders?|by folder|ordner|dossiers?|carpetas?|cartelle)$/i.test(k.title.trim()));
      const queue = [];
      const seen = new Set();
      if (folderView) { queue.push(folderView.id); seen.add(folderView.id); }
      else kids.forEach(k => { if (k.kind === 'container') { if (!seen.has(k.id)) { seen.add(k.id); queue.push(k.id); } } else onItem(k); });
      let calls = 0;
      while (queue.length && calls < 4000) {
        const id = queue.shift();
        calls++;
        let items = [];
        try { items = await this.browseAll(id); } catch (e) { continue; }
        for (const it of items) {
          if (it.kind === 'container') { if (!seen.has(it.id)) { seen.add(it.id); queue.push(it.id); } }
          else onItem(it);
        }
        this.setProgress(label());
      }
    },

    setProgress(text) {
      this.progress = text;
      $$('[data-progress]').forEach(el => { el.textContent = text; });
    },

    async buildIndex() {
      if (!this.server || this.building) return;
      this.building = true;
      const serverId = this.server.id;
      refreshIf(['settings']);
      const tracks = [], videos = [], seen = new Set();
      const label = () => 'Scanning your library… ' + tracks.length + ' songs, ' + videos.length + ' videos';
      try {
        this.roots = null;
        const roots = await this.findRoots();
        const handler = it => {
          if (!it.url || seen.has(it.url)) return;
          if (it.kind === 'audio') {
            seen.add(it.url);
            tracks.push({ title: it.title, artist: it.artist || '', album: it.album || '', genre: it.genre || '', track: it.track || 0, duration: it.duration || 0, url: it.url, art: it.art || '' });
          } else if (it.kind === 'video') {
            seen.add(it.url);
            videos.push({ title: it.title, url: it.url, art: it.art || it.thumb || '', duration: it.duration || 0, date: it.date || '', resolution: it.resolution || '' });
          }
        };
        const order = [];
        [roots.music, roots.video].forEach(r => { if (r && order.indexOf(r) < 0) order.push(r); });
        for (const r of order) await this.crawl(r, handler, label);
        if (!this.server || this.server.id !== serverId) return;
        const data = { version: 2, server: serverId, at: Date.now(), roots: roots, tracks: tracks, videos: videos };
        this.apply(data);
        try { await Bridge.call('saveFile', { name: 'index.json', text: JSON.stringify(data) }); } catch (e) { /* not fatal */ }
        toast('Library ready: ' + tracks.length + ' songs and ' + videos.length + ' videos');
      } catch (e) {
        toast('Couldn’t finish scanning the library. ' + e.message);
      } finally {
        this.building = false;
        this.setProgress('');
        refreshIf(['music', 'videos', 'album', 'artist', 'genre', 'settings', 'home']);
      }
    },

    apply(data) {
      if (data.roots) this.roots = data.roots;
      this.builtAt = data.at || 0;
      const cmp = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
      this.tracks = (data.tracks || []).slice().sort((a, b) => cmp(a.title, b.title));
      this.videos = (data.videos || []).slice().sort((a, b) => cmp(a.title, b.title));

      const albums = new Map();
      for (const t of this.tracks) {
        const name = t.album || 'Unknown album';
        const key = name.toLowerCase();
        let a = albums.get(key);
        if (!a) { a = { key: key, title: name, tracks: [], artists: new Map(), art: '' }; albums.set(key, a); }
        a.tracks.push(t);
        if (t.artist) a.artists.set(t.artist, (a.artists.get(t.artist) || 0) + 1);
        if (!a.art && t.art) a.art = t.art;
      }
      this.albums = [];
      albums.forEach(a => {
        const arts = Array.from(a.artists.entries()).sort((x, y) => y[1] - x[1]);
        a.artist = arts.length === 0 ? 'Unknown artist' : arts.length > 2 && arts[0][1] < a.tracks.length * 0.6 ? 'Various artists' : arts[0][0];
        a.tracks.sort((x, y) => (x.track || 999) - (y.track || 999) || cmp(x.title, y.title));
        delete a.artists;
        this.albums.push(a);
      });
      this.albums.sort((x, y) => cmp(x.title, y.title));
      this.albumMap = albums;

      const artists = new Map();
      for (const t of this.tracks) {
        const name = t.artist || 'Unknown artist';
        let a = artists.get(name.toLowerCase());
        if (!a) { a = { name: name, tracks: [], albums: new Set(), art: '' }; artists.set(name.toLowerCase(), a); }
        a.tracks.push(t);
        a.albums.add((t.album || 'Unknown album').toLowerCase());
        if (!a.art && t.art) a.art = t.art;
      }
      this.artists = Array.from(artists.values()).sort((x, y) => cmp(x.name, y.name));

      const genres = new Map();
      for (const t of this.tracks) {
        if (!t.genre) continue;
        let g = genres.get(t.genre.toLowerCase());
        if (!g) { g = { name: t.genre, tracks: [] }; genres.set(t.genre.toLowerCase(), g); }
        g.tracks.push(t);
      }
      this.genres = Array.from(genres.values()).sort((x, y) => cmp(x.name, y.name));
    },

    search(q) {
      q = q.trim().toLowerCase();
      if (!q) return { tracks: [], albums: [], videos: [] };
      const has = s => (s || '').toLowerCase().indexOf(q) >= 0;
      return {
        albums: this.albums.filter(a => has(a.title) || has(a.artist)).slice(0, 20),
        tracks: this.tracks.filter(t => has(t.title) || has(t.artist) || has(t.album)).slice(0, 300),
        videos: this.videos.filter(v => has(v.title)).slice(0, 60)
      };
    }
  };

  /* ================================================================ Player state */
  let P = { state: 'stopped', position: 0, duration: 0, track: null, upNext: [], shuffle: false, repeat: 'off' };
  let lastTrackUrl = null;
  Bridge.on('player', st => {
    if (!st) return;
    P = st;
    const url = P.track ? P.track.url : null;
    const changed = url !== lastTrackUrl;
    lastTrackUrl = url;
    updatePlayerUi(changed);
  });

  async function playTracks(list, start, shuffle) {
    if (!list || !list.length) return;
    try {
      const st = await Bridge.call('play', { tracks: list, start: start || 0, shuffle: !!shuffle });
      if (st) { P = st; lastTrackUrl = P.track ? P.track.url : null; }
      go({ name: 'now' });
    } catch (e) {
      toast('Couldn’t start playback. ' + e.message);
    }
  }
  function control(action, value) {
    return Bridge.call('control', { action: action, value: value || 0 }).then(st => {
      if (st) { P = st; updatePlayerUi(false); }
    }).catch(() => {});
  }

  const Resume = {
    all() { return Store.get('resume', {}); },
    get(url) { return this.all()[url] || null; },
    save(url, data) { const r = this.all(); r[url] = data; Store.set('resume', r); },
    remove(url) { const r = this.all(); delete r[url]; Store.set('resume', r); },
    clear() { Store.set('resume', {}); }
  };
  let currentVideo = null;
  // The list the current video was started from, so left/right on the controller can move to the
  // previous or next video without leaving the player (like the photo viewer).
  let videoList = null, videoIdx = 0;
  const videoSeen = new Map(); // url -> video, so resume info keeps its title after switching
  function playVideo(v, fromStart, list, idx) {
    const saved = prefs.resume && !fromStart ? Resume.get(v.url) : null;
    currentVideo = v;
    videoList = list && list.length ? list : null;
    videoIdx = idx || 0;
    videoSeen.set(v.url, v);
    if (videoSeen.size > 60) videoSeen.delete(videoSeen.keys().next().value);
    Sfx.play('select');
    Bridge.call('playVideo', { url: v.url, title: v.title, key: v.url, start: saved ? saved.position : 0, index: videoIdx, count: videoList ? videoList.length : 1 })
      .catch(e => toast('Couldn’t play that video. ' + e.message));
  }
  function playVideoIn(list, i) {
    const x = list[i];
    if (!x) return;
    playVideo({ title: x.title, url: x.url, art: x.art || x.thumb || '', duration: x.duration || 0 }, false, list, i);
  }
  Bridge.on('videoStep', d => {
    if (!videoList || videoList.length < 2) return;
    const n = videoList.length;
    playVideoIn(videoList, (videoIdx + (d > 0 ? 1 : -1) + n) % n);
  });
  Bridge.on('videoClosed', d => {
    if (!d || !d.key) return;
    const v = videoSeen.get(d.key) || { url: d.key, title: '' };
    if (d.ended || d.position < 30 || (d.duration && d.position > d.duration - 60)) Resume.remove(d.key);
    else Resume.save(d.key, { position: d.position, duration: d.duration, title: v.title, art: v.art || '', at: Date.now() });
    if (d.switched) return; // moved on to the next video; the player is still open
    // Coming back from the full-screen player: ignore stray direction presses for a moment.
    settleInput(700, 'video closed');
    refreshIf(['videos']);
  });

  /* ================================================================ Collections (grids and lists that grow as you scroll) */
  const CHUNK = 120;
  let Colls = {};
  function coll(id, items, opts) {
    Colls[id] = { items: items, opts: opts, shown: 0, last: 0 };
    const cols = opts.cols || 1;
    const cls = cols > 1 ? 'grid c' + cols : 'list';
    return '<div class="' + cls + '" id="coll-' + id + '" data-coll="' + id + '" data-cols="' + cols + '">' + chunk(id, CHUNK) + '</div>';
  }
  function chunk(id, n) {
    const c = Colls[id];
    const end = Math.min(c.items.length, c.shown + n);
    let h = '';
    for (let i = c.shown; i < end; i++) h += c.opts.item(c.items[i], i);
    c.shown = end;
    return h;
  }
  function more(id, upTo) {
    const c = Colls[id];
    if (!c || c.shown >= c.items.length) return;
    const el = document.getElementById('coll-' + id);
    if (el) el.insertAdjacentHTML('beforeend', chunk(id, Math.max(CHUNK, upTo - c.shown + 1)));
  }

  // Card and row templates. Every focusable element has class "f".
  function card(it, i, o) {
    o = o || {};
    const icon = o.icon ? ico(o.icon) : '';
    return '<button class="card f ' + (o.cls || '') + '" data-i="' + i + '"><span class="art" ' + lazyArt(o.art, o.seed || o.t1) + '>' + (o.art ? '' : icon) + '</span>' +
      '<span class="t1">' + esc(o.t1) + '</span>' + (o.t2 != null ? '<span class="t2">' + esc(o.t2) + '</span>' : '') + (o.bar != null ? '<span class="bar"><i style="width:' + Math.round(o.bar * 100) + '%"></i></span>' : '') + '</button>';
  }
  function row(it, i, o) {
    o = o || {};
    const playing = P.track && it && it.url && P.track.url === it.url ? ' playing' : '';
    return '<button class="row f' + playing + '" data-i="' + i + '">' + (o.n != null ? '<span class="n">' + esc(o.n) + '</span>' : '') +
      (o.thumb !== false ? '<span class="thumb" ' + lazyArt(o.art, o.seed || o.t1) + '>' + (o.art ? '' : ico(o.icon || 'note', '')) + '</span>' : '') +
      '<span class="tt"><span class="t1">' + esc(o.t1) + '</span>' + (o.t2 ? '<span class="t2">' + esc(o.t2) + '</span>' : '') + '</span>' +
      (o.dur ? '<span class="dur">' + esc(o.dur) + '</span>' : '') + '</button>';
  }
  const trackRow = (t, i, numbered) => row(t, i, { n: numbered ? (t.track || i + 1) : i + 1, art: t.art, seed: t.album, t1: t.title, t2: [t.artist, t.album].filter(Boolean).join(' · '), dur: t.duration ? fmtTime(t.duration) : '' });
  const albumCard = (a, i) => card(a, i, { art: a.art, seed: a.title, icon: 'note', t1: a.title, t2: a.artist });
  const videoCard = (v, i) => card(v, i, { cls: 'poster', art: v.art, seed: v.title, icon: 'film', t1: v.title, t2: v.duration ? fmtTime(v.duration) : '' });

  /* ================================================================ Navigation */
  const SECTIONS = [
    { id: 'music', label: 'Music', tiles: [['Albums', 'grid', { name: 'music', view: 'albums' }], ['Artists', 'person', { name: 'music', view: 'artists' }], ['Search', 'search', { name: 'music', view: 'search' }], ['USB drive', 'usb', { name: 'music', view: 'usb' }]] },
    { id: 'videos', label: 'Videos', tiles: [['Movies', 'film', { name: 'videos', view: 'all' }], ['Continue', 'resume', { name: 'videos', view: 'continue' }], ['Folders', 'folder', { name: 'videos', view: 'folders' }], ['USB drive', 'usb', { name: 'videos', view: 'usb' }]] },
    { id: 'photos', label: 'Photos', tiles: [['Library', 'photo', { name: 'photos', view: 'library' }], ['USB drive', 'usb', { name: 'photos', view: 'usb' }]] },
    { id: 'settings', label: 'Settings', tiles: [['Sources', 'server', { name: 'settings', view: 'sources' }], ['Playback', 'gear', { name: 'settings', view: 'playback' }], ['Colors', 'palette', { name: 'settings', view: 'colors' }], ['About', 'info', { name: 'settings', view: 'about' }]] }
  ];
  let homeIdx = 0;
  let route = { name: 'home' };
  let stack = [];
  let loadToken = 0;

  function saveNav() { Store.set('nav', { route: route, stack: stack.slice(-20), homeIdx: homeIdx, at: Date.now() }); }

  function go(r, opts) {
    opts = opts || {};
    if (!opts.replace) stack.push({ route: route, focus: focusKey() });
    route = r;
    if (!opts.silent) Sfx.play('select');
    render({ dir: 'fwd' });
  }
  function back() {
    lastBackAt = Date.now();
    if (Viewer.open) { Viewer.close(); return; }
    if (Viz.open) { Viz.close(); return; }
    if (!stack.length) {
      if (route.name !== 'home') { route = { name: 'home' }; Sfx.play('back'); render({ dir: 'back' }); }
      return;
    }
    const prev = stack.pop();
    route = prev.route;
    Sfx.play('back');
    render({ dir: 'back', focus: prev.focus });
  }
  function home() {
    stack = [];
    route = { name: 'home' };
    Sfx.play('back');
    render({ dir: 'back' });
  }
  function setView(v) {
    // Switch the left-rail view inside a section without a full transition.
    route = Object.assign({}, route, { view: v });
    Sfx.play('move', ['albums', 'artists', 'songs', 'genres', 'folders', 'usb', 'all', 'continue', 'library', 'sources', 'playback', 'colors', 'index', 'about'].indexOf(v));
    $$('.rail[data-v]').forEach(el => el.classList.toggle('cap', el.dataset.v === v));
    const h = $('.sec-head h1');
    const r = renderers[route.name](route);
    if (h && r.title) h.textContent = r.title;
    fillContent(r);
    saveNav();
  }
  function refreshIf(names) {
    if (names.indexOf(route.name) < 0) return;
    if (document.activeElement && document.activeElement.tagName === 'INPUT') {
      if (route.view === 'search') renderSearchResults();
      return;
    }
    if (route.name === 'home') return; // home tiles don't depend on the library
    const key = focusKey();
    const r = renderers[route.name](route);
    if (r.title) { const h = $('.sec-head h1'); if (h) h.textContent = r.title; }
    fillContent(r, key);
  }

  /* ================================================================ Rendering */
  function render(opts) {
    opts = opts || {};
    if (Viz.open && route.name !== 'now') Viz.close();
    Colls = {};
    loadToken++;
    const screen = $('#screen');
    const r = renderers[route.name](route);
    document.body.classList.toggle('at-home', route.name === 'home');
    screen.className = opts.dir === 'back' ? 'back-nav' : '';
    screen.innerHTML = r.shell;
    cur = null;
    if (r.content !== undefined) fillContent(r, opts.focus, true);
    else restoreFocus(opts.focus);
    if (r.after) r.after();
    saveNav();
  }

  function fillContent(r, focus, initial) {
    const box = $('#content');
    if (!box) { restoreFocus(focus); return; }
    const hadFocusInContent = cur && box.contains(cur);
    const prune = () => Object.keys(Colls).forEach(k => { if (!document.getElementById('coll-' + k)) delete Colls[k]; });
    box.innerHTML = r.content;
    box.scrollTop = 0;
    prune();
    if (r.load) {
      const token = ++loadToken;
      r.load().then(html => {
        if (token !== loadToken || !document.body.contains(box)) return;
        box.innerHTML = html;
        prune();
        if (initial || hadFocusInContent || !cur || !document.body.contains(cur)) restoreFocus(focus, true);
      }).catch(e => {
        if (token !== loadToken) return;
        box.innerHTML = emptyState('Couldn’t load this', e.message, '');
        if (!cur || !document.body.contains(cur)) restoreFocus(null);
      });
    }
    if (initial) restoreFocus(focus);
    else if (focus) restoreFocus(focus, true);
    else if (!cur || !document.body.contains(cur)) restoreFocus(null);
  }

  function focusKey() {
    if (!cur) return null;
    const c = cur.closest('[data-coll]');
    if (c) return { coll: c.dataset.coll, i: +cur.dataset.i };
    if (cur.dataset.k) return { k: cur.dataset.k };
    return null;
  }
  function restoreFocus(key, preferContent) {
    let el = null;
    if (key && key.coll && Colls[key.coll]) {
      if (key.i >= Colls[key.coll].shown) more(key.coll, key.i);
      el = $('#coll-' + key.coll + ' [data-i="' + Math.min(key.i, Colls[key.coll].items.length - 1) + '"]');
    } else if (key && key.k) {
      el = $('#screen [data-k="' + key.k + '"]');
    }
    if (!el && preferContent) el = $('#content .f');
    if (!el) el = $('#screen [data-autofocus]') || $('#content .f') || $('#screen .f');
    if (el) setFocus(el, { silent: true });
  }

  /* ================================================================ Focus and spatial navigation */
  let cur = null;
  function setFocus(el, opts) {
    opts = opts || {};
    if (!el) return;
    if (cur && cur !== el) cur.classList.remove('focus');
    cur = el;
    el.classList.add('focus');
    const c = el.closest('[data-coll]');
    if (c && Colls[c.dataset.coll]) Colls[c.dataset.coll].last = +el.dataset.i;
    if (!opts.noScroll) bringIntoView(el, !opts.silent);
    if (el.dataset.menu != null) onMenuFocus(+el.dataset.menu, opts.silent);
    const menu = $('.home-menu');
    if (menu) menu.classList.toggle('unfocused', el.dataset.menu == null);
  }
  // Scrolls a list so the focused item shows, with a quick 110 ms glide. (The browser's own
  // smooth scrolling takes ~300 ms and falls behind when a direction is held down.)
  const glides = new Map(); // scroll box -> { to, raf }
  function scrollBoxOf(el) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (p.scrollHeight > p.clientHeight + 1) {
        const oy = getComputedStyle(p).overflowY;
        if (oy === 'auto' || oy === 'scroll') return p;
      }
    }
    return null;
  }
  function bringIntoView(el, animate) {
    const box = scrollBoxOf(el);
    if (!box) return;
    const scale = box.getBoundingClientRect().height / box.offsetHeight || 1; // the stage is scaled to the screen
    const br = box.getBoundingClientRect(), r = el.getBoundingClientRect();
    const g = glides.get(box);
    const from = g ? g.to : box.scrollTop;
    const margin = 28;
        const elTop = (r.top - br.top) / scale + box.scrollTop, elBottom = elTop + r.height / scale;
    let to = from;
    if (elTop - margin < from) to = elTop - margin;
    else if (elBottom + margin > from + box.clientHeight) to = elBottom + margin - box.clientHeight;
    to = Math.max(0, Math.min(box.scrollHeight - box.clientHeight, Math.round(to)));
    if (to === from && !g) return;
    if (!animate) { if (g) cancelAnimationFrame(g.raf); glides.delete(box); box.scrollTop = to; return; }
    const start = box.scrollTop, t0 = performance.now(), dur = 110;
    if (g) cancelAnimationFrame(g.raf);
    const job = { to: to, raf: 0 };
    glides.set(box, job);
    const step = now => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      box.scrollTop = start + (to - start) * e;
      if (k < 1) job.raf = requestAnimationFrame(step); else glides.delete(box);
    };
    job.raf = requestAnimationFrame(step);
  }
  function visible(el) {
    if (!el.offsetParent) return false;
    if (getComputedStyle(el).visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function nearest(from, dir) {
    // First look only at what's on screen (fast even in huge grids); if nothing is there, look
    // further, e.g. the song list below an artist's albums.
    return nearestIn(from, dir, true) || nearestIn(from, dir, false);
  }
  function nearestIn(from, dir, onScreen) {
    const fr = from.getBoundingClientRect();
    const fromColl = from.closest('[data-coll]');
    let best = null, bestScore = Infinity;
    const boxRects = new Map();
    const W = window.innerWidth, H = window.innerHeight;
    $$('#screen .f').forEach(el => {
      if (el === from) return;
      if (fromColl && fromColl.contains(el)) return;
      // Measure first and drop anything off screen or scrolled out of its list, so big grids
      // don't slow every move down; the style check below only runs for what's left.
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      if (onScreen && (r.bottom < 0 || r.top > H || r.right < 0 || r.left > W)) return;
      const box = onScreen && el.closest('.content');
      if (box) {
        let br = boxRects.get(box);
        if (!br) { br = box.getBoundingClientRect(); boxRects.set(box, br); }
        if (r.bottom <= br.top + 2 || r.top >= br.bottom - 2) return;
      }
      if (!visible(el)) return;
      let primary, secondary;
      if (dir === 'right') { if (r.left < fr.right - 4) return; primary = r.left - fr.right; secondary = Math.max(0, Math.max(r.top - fr.bottom, fr.top - r.bottom)); }
      else if (dir === 'left') { if (r.right > fr.left + 4) return; primary = fr.left - r.right; secondary = Math.max(0, Math.max(r.top - fr.bottom, fr.top - r.bottom)); }
      else if (dir === 'down') { if (r.top < fr.bottom - 4) return; primary = r.top - fr.bottom; secondary = Math.max(0, Math.max(r.left - fr.right, fr.left - r.right)); }
      else { if (r.bottom > fr.top + 4) return; primary = fr.top - r.bottom; secondary = Math.max(0, Math.max(r.left - fr.right, fr.left - r.right)); }
      const centerOff = dir === 'left' || dir === 'right'
        ? Math.abs((r.top + r.bottom) / 2 - (fr.top + fr.bottom) / 2)
        : Math.abs((r.left + r.right) / 2 - (fr.left + fr.right) / 2);
      const score = primary + secondary * 3 + centerOff * 0.3;
      if (score < bestScore) { bestScore = score; best = el; }
    });
    // Going back to the home menu lands on the selected section, not just the closest one.
    if (best && best.dataset.menu != null && from.dataset.menu == null) {
      best = $('.menu-btn[data-menu="' + homeIdx + '"]') || best;
    }
    // Same for the left-hand list in a section: land on the view you're in.
    if (best && best.closest('.rail-col') && !from.closest('.rail-col') && dir === 'left') {
      best = $('#screen .rail.cap') || best;
    }
    // Entering a grid or list: return to the item you were last on.
    if (best) {
      const c = best.closest('[data-coll]');
      if (c && c !== fromColl && Colls[c.dataset.coll]) {
        const last = c.querySelector('[data-i="' + Colls[c.dataset.coll].last + '"]');
        if (last && visible(last)) {
          const lr = last.getBoundingClientRect();
          const box = c.closest('.content');
          const br = box ? box.getBoundingClientRect() : null;
          if (!br || (lr.bottom > br.top && lr.top < br.bottom)) best = last;
        }
      }
    }
    return best;
  }
  function moveFocus(dir) {
    if (Viewer.open) { if (dir === 'left') Viewer.step(-1); else if (dir === 'right') Viewer.step(1); return; }
    if (cur && !document.body.contains(cur)) {
      // The screen was redrawn under us; pick up the same item in the new drawing.
      const key = focusKey();
      const again = key && key.k ? $('#screen [data-k="' + key.k + '"]') : null;
      if (again) setFocus(again, { silent: true }); else { restoreFocus(key); return; }
    }
    if (!cur) { restoreFocus(null); return; }
    // Scrollable boxes (like the log): up/down scroll inside first, then move on at the ends.
    if (cur.hasAttribute('data-scroll') && (dir === 'up' || dir === 'down')) {
      const max = cur.scrollHeight - cur.clientHeight;
      if (dir === 'down' ? cur.scrollTop < max - 1 : cur.scrollTop > 0) {
        cur.scrollBy({ top: (dir === 'down' ? 1 : -1) * Math.round(cur.clientHeight * 0.6), behavior: 'smooth' });
        cur.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return;
      }
    }
    const c = cur.closest('[data-coll]');
    if (c && Colls[c.dataset.coll]) {
      const id = c.dataset.coll, info = Colls[id], cols = +c.dataset.cols, i = +cur.dataset.i, n = info.items.length;
      let j = null;
      if (dir === 'left' && i % cols > 0) j = i - 1;
      else if (dir === 'right' && i % cols < cols - 1 && i + 1 < n) j = i + 1;
      else if (dir === 'down' && i + cols < n) j = i + cols;
      else if (dir === 'down' && cols > 1 && Math.floor(i / cols) < Math.floor((n - 1) / cols)) j = n - 1;
      else if (dir === 'up' && i - cols >= 0) j = i - cols;
      if (j != null) {
        if (j >= info.shown) more(id, j + cols * 4);
        const el = c.querySelector('[data-i="' + j + '"]');
        if (el) { setFocus(el); Sfx.play('tick', j); return; }
      }
    }
    const el = nearest(cur, dir);
    if (el) {
      setFocus(el);
      if (el.dataset.menu != null) return; // the menu plays its own note
      if (el.classList.contains('rail')) Sfx.play('move', $$('.rail').indexOf(el));
      else Sfx.play('tick', el.dataset.i ? +el.dataset.i : 0);
    }
  }
  function activate(el) {
    if (!el) return;
    const input = el.tagName === 'INPUT' ? el : el.querySelector('input');
    if (input) { input.focus(); return; }
    const c = el.closest('[data-coll]');
    if (c && Colls[c.dataset.coll]) {
      const info = Colls[c.dataset.coll];
      const i = +el.dataset.i;
      if (info.opts.open) info.opts.open(info.items[i], i);
      return;
    }
    const act = el.dataset.act;
    if (act && Actions[act]) Actions[act](el);
  }

  /* ================================================================ Input: keyboard, Xbox controller keys, Gamepad API */
  const KEYMAP = {
    37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'a', 32: 'a', 27: 'b', 8: 'b',
    195: 'a', 196: 'b', 197: 'x', 198: 'y', 199: 'rb', 200: 'lb', 201: 'lt', 202: 'rt',
    203: 'up', 204: 'down', 205: 'left', 206: 'right', 207: 'menu', 208: 'view',
    211: 'up', 212: 'down', 213: 'right', 214: 'left'
  };
  let padKeys = false;
  // False while the Xbox guide or another app is in front of WMC SX.
  let appActive = true;
  const isActive = () => appActive && document.visibilityState !== 'hidden';
  Bridge.on('active', on => {
    appActive = !!on;
    // Forget any buttons that were held while we weren't in front.
    if (on) settleInput(350, 'app active again');
  });
  let lastPoll = { action: null, t: 0 };
  let lastBackAt = 0;

  // When the interface comes back (from the video player or the guide), the engine can deliver
  // direction presses nobody made: key repeats for a key it thinks is still held, or a stale
  // controller reading. Those made focus jump a tile or two left or right after closing a video.
  // For a short moment afterwards, direction input is ignored, and a key repeat only counts when
  // its first press was seen here. Ignored presses go to the log so any leftovers can be traced.
  let settleUntil = 0, settleWhy = '';
  const keysDown = new Set();
  function settleInput(ms, why) {
    settleUntil = Date.now() + ms; settleWhy = why;
    keysDown.clear();
    pad.held = {}; pad.next = {}; pad.ignoreUntilRelease = true;
  }
  const DIRS = { up: 1, down: 1, left: 1, right: 1 };
  document.addEventListener('keyup', e => keysDown.delete(e.keyCode));
  window.addEventListener('blur', () => keysDown.clear());

  document.addEventListener('keydown', e => {
    if (!isActive()) return;
    const code = e.keyCode;
    const dirKey = DIRS[KEYMAP[code]];
    if (dirKey && (Date.now() < settleUntil || (e.repeat && !keysDown.has(code)))) {
      e.preventDefault();
      nativeLog('input: ignored key ' + code + (e.repeat ? ' (repeat)' : '') + ' ' + (Date.now() < settleUntil ? 'just after ' + settleWhy : 'with no first press'));
      return;
    }
    if (!e.repeat) keysDown.add(code);
    if (code >= 195 && code <= 218) padKeys = true;
    const input = document.activeElement && document.activeElement.tagName === 'INPUT' ? document.activeElement : null;
    let action = KEYMAP[code];
    if (!input && !action) {
      const k = (e.key || '').toLowerCase();
      if (k === 'x' || k === 'y') action = k;
      else if (k === 'q') action = 'lb';
      else if (k === 'e') action = 'rb';
      else if (k === 'm') action = 'menu';
      else if (k === 'h') action = 'view';
    }
    if (input) {
      // Typing: let the text box keep left/right/backspace; Enter, B or Down leave it.
      if (code === 13 || code === 27 || code === 195 || code === 196 || code === 40 || code === 204) {
        e.preventDefault();
        input.blur();
        if (code === 40 || code === 204) moveFocus('down');
      }
      return;
    }
    if (!action) return;
    e.preventDefault();
    if (Date.now() - lastPoll.t < 120 && lastPoll.action === action) return;
    handle(action);
  });

  // Mouse support (useful on a PC; the Xbox uses the controller).
  document.addEventListener('mousemove', e => {
    const el = e.target.closest && e.target.closest('#screen .f');
    if (el && el !== cur) setFocus(el, { noScroll: true, silent: true });
  });
  document.addEventListener('click', e => {
    if (Intro.active) { if (Intro.finish) Intro.finish(); return; }
    if (Viewer.open) { Viewer.close(); return; }
    if (Viz.open) { Viz.close(); return; }
    const hint = e.target.closest && e.target.closest('.hint');
    if (hint && /Visualizer/.test(hint.textContent) && P.track) { Viz.show(); return; }
    const el = e.target.closest && e.target.closest('#screen .f');
    if (!el) return;
    setFocus(el, { noScroll: true, silent: true });
    activate(el);
  });

  function handle(action) {
    if (Intro.active) { if (Intro.finish) Intro.finish(); return; }
    if (Viz.open && Viz.handle(action)) return;
    switch (action) {
      case 'up': case 'down': case 'left': case 'right': moveFocus(action); break;
      case 'a':
        if (Viewer.open) { Viewer.toggleShow(); break; }
        activate(cur); break;
      case 'b': back(); break;
      case 'x': if (P.track) control('toggle'); break;
      case 'y':
        if (route.name === 'now') { if (P.track) Viz.show(); break; }
        if (route.name === 'music' || route.name === 'videos') { setView('search'); const s = $('#searchBox'); if (s) { setFocus(s.closest('.f')); s.focus(); } }
        break;
      case 'lb': if (P.track) control('prev'); break;
      case 'rb': if (P.track) control('next'); break;
      case 'lt': if (P.track) control('skip', -10); break;
      case 'rt': if (P.track) control('skip', 30); break;
      case 'menu': if (P.track && route.name !== 'now') go({ name: 'now' }); break;
      case 'view': home(); break;
    }
  }

  Bridge.on('back', () => {
    if (!isActive()) return;
    if (Date.now() - lastBackAt < 400) return;
    back();
  });

  // Gamepad API fallback, used until the WebView reports controller key events.
  const pad = { held: {}, next: {} };
  const PADMAP = { 0: 'a', 1: 'b', 2: 'x', 3: 'y', 4: 'lb', 5: 'rb', 6: 'lt', 7: 'rt', 8: 'view', 9: 'menu', 12: 'up', 13: 'down', 14: 'left', 15: 'right' };
  const REPEATS = { up: 1, down: 1, left: 1, right: 1 };
  function pollPads(now) {
    if (!isActive()) { pad.held = {}; pad.ignoreUntilRelease = true; }
    else if (!padKeys && navigator.getGamepads) {
      const pads = navigator.getGamepads();
      const active = {};
      for (let p = 0; p < pads.length; p++) {
        const gp = pads[p];
        if (!gp) continue;
        Object.keys(PADMAP).forEach(b => { if (gp.buttons[b] && gp.buttons[b].pressed) active[PADMAP[b]] = true; });
        const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
        if (ax < -0.6) active.left = true; else if (ax > 0.6) active.right = true;
        if (ay < -0.6) active.up = true; else if (ay > 0.6) active.down = true;
      }
      if (pad.ignoreUntilRelease) {
        // Buttons still held from the guide or another app count as already handled.
        Object.keys(active).forEach(a => { pad.held[a] = true; pad.next[a] = Infinity; });
        pad.ignoreUntilRelease = false;
      }
      Object.keys(active).forEach(a => {
        if (DIRS[a] && Date.now() < settleUntil) { pad.held[a] = true; pad.next[a] = Infinity; return; }
        if (!pad.held[a]) {
          pad.held[a] = true;
          pad.next[a] = now + 300;
          lastPoll = { action: a, t: Date.now() };
          handle(a);
        } else if (REPEATS[a] && now >= pad.next[a]) {
          pad.next[a] = now + 85;
          handle(a);
        }
      });
      Object.keys(pad.held).forEach(a => { if (!active[a]) delete pad.held[a]; });
    }
    requestAnimationFrame(pollPads);
  }

  /* ================================================================ Common layout pieces */
  function hintsHtml(list) {
    return '<div class="hints">' + list.map(h => '<span class="hint"><span class="hb ' + h[0].toLowerCase() + '">' + h[0] + '</span>' + esc(h[1]) + '</span>').join('') + '</div>';
  }
  function miniHtml(delay) {
    const t = P.track;
    const show = t && P.state !== 'stopped';
    return '<button class="mini glass f ' + (delay || '') + ' enter" data-act="now" data-k="mini" id="mini" style="' + (show ? '' : 'visibility:hidden') + '">' +
      '<span class="art-s" id="miniArt" style="' + artBg(t && t.art, t && t.album) + '"></span>' +
      '<span class="t"><span class="label" id="miniLabel">' + (P.state === 'paused' ? 'PAUSED' : 'NOW PLAYING') + '</span>' +
      '<span class="title" id="miniTitle">' + esc(t ? t.title : '') + '</span>' +
      '<span class="sub" id="miniSub">' + esc(t ? [t.artist, t.album].filter(Boolean).join(' · ') : '') + '</span></span>' +
      '<span class="progress"><i id="miniBar" style="width:' + pct() + '%"></i></span></button>';
  }
  function pct() { return P.duration ? Math.min(100, (P.position / P.duration) * 100) : 0; }
  function footer(hints) {
    return '<div class="foot">' + miniHtml('d3') + hintsHtml(hints) + '</div>';
  }
  function sourceLine() {
    if (!Lib.server) return '<div class="src"><span class="dot off"></span>Looking for your NAS…</div>';
    return '<div class="src"><span class="dot"></span>' + esc(Lib.server.name) + ' · DLNA</div>';
  }
  function sectionShell(o) {
    const rail = o.rail ? '<nav class="rail-col" aria-label="' + esc(o.title) + ' views">' +
      (o.search ? '<label class="search glass f enter d1" data-k="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>' +
        '<input id="searchBox" placeholder="' + esc(o.search) + '" value="' + esc(route.q || '') + '" autocomplete="off" spellcheck="false"></label>' : '') +
      o.rail.map((r, i) => '<button class="rail f enter d' + Math.min(5, i + 1) + (r[0] === o.active ? ' cap' : '') + '" data-act="view" data-v="' + r[0] + '" data-k="rail-' + r[0] + '">' + esc(r[1]) + '</button>').join('') +
      (o.source ? sourceLine() : '') + '</nav>' : '';
    return '<div class="sec-head"><button class="crumb enter" data-act="back">‹ ' + esc(o.crumb) + '</button><h1 class="title-in">' + esc(o.title) + '</h1></div>' +
      rail + '<div class="content' + (o.rail ? '' : ' full') + '" id="content"></div>' + footer(o.hints || [['A', 'Select'], ['B', 'Back']]);
  }
  function emptyState(title, text, buttons) {
    return '<div class="empty glass enter d1"><h2>' + esc(title) + '</h2><p>' + esc(text) + '</p>' + (buttons ? '<div class="btn-row">' + buttons + '</div>' : '') + '</div>';
  }
  function libraryGate() {
    if (!Lib.server) return emptyState('Looking for your media server', 'WMC SX is searching your home network for a DLNA media server, like your Synology NAS. This usually takes a few seconds.', '<button class="btn cap f" data-act="go" data-route="settings:sources">Open Sources</button>');
    if (Lib.building && !Lib.tracks.length && !Lib.videos.length) return '<div class="empty glass enter d1"><h2>Scanning your library</h2><p data-progress>' + esc(Lib.progress || 'Starting…') + '</p><div class="spinner"></div></div>';
    return null;
  }
  const loading = () => '<div class="empty glass fade-in"><h2>Loading…</h2><div class="spinner"></div></div>';

  /* ================================================================ Folder browsing (DLNA and USB) */
  const FOLDER_VIEW = /^(folders?|by folder|ordner|dossiers?|carpetas?|cartelle)$/i;
  const FIRST_PAGE = 400;   // shown straight away; the rest of a big folder streams in behind it
  // Reads the first part of a folder, then hands later pages to whoever calls onMore().
  function browseProgressive(id) {
    return new Promise((resolve, reject) => {
      const first = [];
      let resolved = false, listener = null, total = 0;
      const backlog = [];
      Lib.browsePages(id, (items, t, done) => {
        total = t;
        if (!resolved) {
          first.push.apply(first, items);
          if (done || first.length >= FIRST_PAGE) {
            resolved = true;
            resolve({ items: first, total: total, done: done, onMore: fn => { listener = fn; backlog.splice(0).forEach(b => fn(b[0], b[1], b[2])); } });
          }
          return;
        }
        if (listener) return listener(items, t, done);
        backlog.push([items, t, done]);
      }, { size: 500 }).catch(e => { if (!resolved) reject(e); else if (listener) listener(null, total, true, e); });
    });
  }

  function folderLoader(kind, source, id) {
    return async () => {
      let first;
      if (source === 'usb') first = { items: await Bridge.call('usbList', { path: id || '' }), done: true };
      else {
        if (!Lib.server) return libraryGate();
        if (!id) {
          const roots = await Lib.findRoots();
          id = roots[kind === 'music' ? 'music' : kind === 'video' ? 'video' : 'photo'] || '0';
          // NAS media servers offer several views (All, Album, Folder…). Start in the folder view.
          const top = await Lib.browseAll(id, 2000);
          const fv = top.find(x => x.kind === 'container' && FOLDER_VIEW.test((x.title || '').trim()));
          if (fv) id = fv.id;
          else first = { items: top, done: true };
        }
        if (!first) first = await browseProgressive(id);
      }
      const want = kind === 'music' ? 'audio' : kind === 'video' ? 'video' : 'image';
      const all = [], files = [], tracks = [];
      let folderCount = 0;
      const take = items => items.forEach(x => {
        if (x.kind === 'container') { folderCount++; all.push({ folder: x }); }
        else if (x.kind === want) {
          // Remember where the file sits among the files, for the photo viewer and playlists.
          x._n = files.length;
          files.push(x);
          if (kind === 'music') tracks.push(slimTrack(x));
          all.push(x);
        }
      });
      // Folders first, like before; later pages are added in the order the server sends them.
      take(first.items.filter(x => x.kind === 'container'));
      take(first.items.filter(x => x.kind !== 'container'));
      if (!all.length && first.done) {
        if (source === 'usb' && !id) return emptyState('No USB drive found', 'Plug a USB drive or a Windows-formatted iPod into the Xbox. Drives need to be exFAT, FAT32 or NTFS.', '<button class="btn glass f" data-act="refresh">Check again</button>');
        return emptyState('Nothing here', 'This folder doesn’t contain any ' + (kind === 'music' ? 'music' : kind === 'video' ? 'videos' : 'photos') + '.', '');
      }
      const noun = kind === 'music' ? ['song', 'songs'] : kind === 'video' ? ['video', 'videos'] : ['photo', 'photos'];
      const countText = (loading) => {
        const parts = [];
        if (files.length || !folderCount) parts.push(files.length.toLocaleString() + ' ' + noun[files.length === 1 ? 0 : 1]);
        if (folderCount) parts.push(folderCount.toLocaleString() + (folderCount === 1 ? ' folder' : ' folders'));
        return parts.join(' · ') + (loading ? ' · loading more…' : '');
      };
      const countLine = '<div class="count-line" id="folderCount">' + esc(countText(!first.done)) + '</div>';
      const openFolder = f => go({ name: 'folder', kind: kind, source: source, id: f.id, title: f.title });
      let html = '';
      if (kind === 'music') {
        let head = '';
        if (files.length) head = '<div class="btn-row" style="margin-bottom:18px"><button class="btn cap f" data-act="playList" data-list="folder">' + SVG.play.replace('<svg', '<svg width="22" height="22" style="fill:#fff"') + 'Play all</button><button class="btn glass f" data-act="playList" data-list="folder" data-shuffle="1">Shuffle</button>' +
          (source === 'usb' && id ? '<button class="btn glass f" data-act="usbScan" data-path="' + esc(id) + '">All music on this drive</button>' : '') + '</div>';
        else if (source === 'usb' && id) head = '<div class="btn-row" style="margin-bottom:18px"><button class="btn glass f" data-act="usbScan" data-path="' + esc(id) + '">All music on this drive</button></div>';
        folderTracks = tracks;
        html = countLine + head + coll('folder', all, {
          item: (x, i) => x.folder ? row(x, i, { art: '', icon: x.folder.drive ? 'usb' : 'folder', t1: x.folder.title, t2: x.folder.childCount != null ? x.folder.childCount + ' items' : 'Folder', thumb: true })
            : trackRow(x, i, false),
          open: x => x.folder ? openFolder(x.folder) : playTracks(tracks, x._n)
        });
      } else {
        html = countLine + coll('folder', all, {
          cols: kind === 'video' ? 6 : 5,
          item: (x, i) => x.folder ? card(x, i, { cls: kind === 'video' ? 'poster' : 'photo', icon: x.folder.drive ? 'usb' : 'folder', seed: x.folder.title, t1: x.folder.title, t2: x.folder.childCount != null ? x.folder.childCount + ' items' : 'Folder', art: '' })
            : kind === 'video' ? videoCard({ title: x.title, art: x.art || x.thumb, duration: x.duration, url: x.url }, i)
              : card(x, i, { cls: 'photo', art: x.thumb || x.view || x.art || x.url, seed: x.title, icon: 'photo', t1: x.title }),
          open: x => {
            if (x.folder) return openFolder(x.folder);
            if (kind === 'video') return playVideoIn(files, x._n);
            Viewer.show(files, x._n);
          }
        });
      }
      if (!first.done && first.onMore) {
        // Keep adding the rest of a big folder while this screen is open.
        const mine = Colls.folder;
        // Wait until the grid is on screen before adding to it.
        setTimeout(() => first.onMore((items, total, done, err) => {
          if (Colls.folder !== mine) return false;   // left this folder: stop reading
          if (items) {
            take(items);
            // Draw the new items if the grid hasn't filled its first screenful yet.
            if (mine.shown < CHUNK) more('folder', CHUNK - 1);
          }
          const el = document.getElementById('folderCount');
          if (el) el.textContent = countText(!done) + (err ? ' · couldn’t read the rest' : '');
          if (Viewer.open && Viewer.list === files) Viewer.info();
        }), 0);
      }
      return html;
    };
  }
  let folderTracks = [];
  function slimTrack(t) {
    return { title: t.title, artist: t.artist || '', album: t.album || '', genre: t.genre || '', track: t.track || 0, duration: t.duration || 0, url: t.url, art: t.art || '' };
  }

  /* ================================================================ Screens */
  let searchTracks = [];
  const renderers = {
    home() {
      const s = SECTIONS[homeIdx];
      const shell = '<div class="home"><div class="clock-home" id="clockHome">' + clockText() + '</div></div>' +
        '<div class="home-wrap"><nav class="home-menu" aria-label="Main menu"><div class="menu-cap cap" id="menuCap" style="top:' + homeIdx * 104 + 'px" aria-hidden="true"></div>' +
        SECTIONS.map((x, i) => '<button class="menu-btn f menu-in d' + (i + 1) + (i === homeIdx ? ' on' : '') + '" data-menu="' + i + '" data-k="menu-' + i + '" data-act="section"' + (i === homeIdx ? ' data-autofocus' : '') + '>' + esc(x.label) + '</button>').join('') +
        '</nav><div class="tiles" id="tiles">' + tilesHtml(s) + '</div></div>' +
        '<div class="foot">' + miniHtml('menu-in d3') + hintsHtml([['A', 'Select']]) + '</div>';
      return { shell: shell };
    },

    music(r) {
      const view = r.view || 'albums';
      const titles = { albums: 'Albums', artists: 'Artists', songs: 'Songs', genres: 'Genres', folders: 'Folders', usb: 'USB drive', search: 'Search' };
      const out = {
        title: titles[view] || 'Music',
        shell: sectionShell({
          crumb: 'Home › Music', title: titles[view] || 'Music', active: view, search: 'Search music', source: true,
          rail: [['albums', 'Albums'], ['artists', 'Artists'], ['songs', 'Songs'], ['genres', 'Genres'], ['folders', 'Folders'], ['usb', 'USB drive']],
          hints: [['A', 'Play'], ['Y', 'Search'], ['B', 'Back']]
        })
      };
      if (view === 'folders') { out.content = loading(); out.load = folderLoader('music', 'dlna', null); return out; }
      if (view === 'usb') { out.content = loading(); out.load = folderLoader('music', 'usb', null); return out; }
      if (view === 'search') { out.content = searchHtml('music'); return out; }
      const gate = libraryGate();
      if (gate) { out.content = gate; return out; }
      if (!Lib.tracks.length) { out.content = emptyState('No music found', 'Your media server didn’t share any music. Check that the music folder is indexed by your NAS’s media server, then rebuild the library in Settings.', '<button class="btn cap f" data-act="go" data-route="settings:index">Library settings</button>'); return out; }
      if (view === 'albums') out.content = coll('albums', Lib.albums, { cols: 5, item: albumCard, open: a => go({ name: 'album', key: a.key }) });
      else if (view === 'artists') out.content = coll('artists', Lib.artists, { item: (a, i) => row(a, i, { art: a.art, seed: a.name, icon: 'person', t1: a.name, t2: a.albums.size + (a.albums.size === 1 ? ' album · ' : ' albums · ') + a.tracks.length + (a.tracks.length === 1 ? ' song' : ' songs') }), open: a => go({ name: 'artist', name2: a.name }) });
      else if (view === 'songs') out.content = playButtons('songs') + coll('songs', Lib.tracks, { item: (t, i) => trackRow(t, i, false), open: (t, i) => playTracks(Lib.tracks, i) });
      else if (view === 'genres') out.content = Lib.genres.length ? coll('genres', Lib.genres, { item: (g, i) => row(g, i, { icon: 'tag', seed: g.name, t1: g.name, t2: g.tracks.length + ' songs' }), open: g => go({ name: 'genre', name2: g.name }) }) : emptyState('No genres', 'Your music doesn’t have genre tags.', '');
      return out;
    },

    album(r) {
      const a = Lib.albumMap.get(r.key);
      const shell = sectionShell({ crumb: 'Music › Albums', title: a ? a.title : 'Album', hints: [['A', 'Play'], ['X', 'Play/Pause'], ['B', 'Back']] });
      if (!a) return { shell: shell, content: emptyState('Album not found', 'It may have been removed from your library.', '') };
      return {
        shell: shell, title: a.title,
        content: '<div class="album-head enter"><div class="art-l" style="' + artBg(a.art, a.title) + '"></div><div class="meta"><div class="t1">' + esc(a.title) + '</div><div class="t2">' + esc(a.artist) + ' · ' + a.tracks.length + ' songs · ' + fmtTime(a.tracks.reduce((s, t) => s + (t.duration || 0), 0)) + '</div>' +
          '<div class="btn-row" style="margin-top:14px"><button class="btn cap f" data-act="playList" data-list="album" data-autofocus>' + SVG.play.replace('<svg', '<svg width="22" height="22" style="fill:#fff"') + 'Play</button><button class="btn glass f" data-act="playList" data-list="album" data-shuffle="1">Shuffle</button></div></div></div>' +
          coll('album', a.tracks, { item: (t, i) => row(t, i, { n: t.track || i + 1, thumb: false, t1: t.title, t2: t.artist !== a.artist ? t.artist : '', dur: t.duration ? fmtTime(t.duration) : '' }), open: (t, i) => playTracks(a.tracks, i) })
      };
    },

    artist(r) {
      const a = Lib.artists.find(x => x.name === r.name2);
      const shell = sectionShell({ crumb: 'Music › Artists', title: r.name2 || 'Artist', hints: [['A', 'Play'], ['B', 'Back']] });
      if (!a) return { shell: shell, content: emptyState('Artist not found', '', '') };
      const albums = Lib.albums.filter(x => a.albums.has(x.key));
      return {
        shell: shell, title: a.name,
        content: playButtons('artist') + (albums.length ? '<h2 class="enter" style="font-size:28px;margin:6px 0 16px">Albums</h2>' + coll('artistAlbums', albums, { cols: 6, item: albumCard, open: x => go({ name: 'album', key: x.key }) }) : '') +
          '<h2 class="enter" style="font-size:28px;margin:30px 0 16px">Songs</h2>' + coll('artistSongs', a.tracks, { item: (t, i) => trackRow(t, i, false), open: (t, i) => playTracks(a.tracks, i) })
      };
    },

    genre(r) {
      const g = Lib.genres.find(x => x.name === r.name2);
      const shell = sectionShell({ crumb: 'Music › Genres', title: r.name2 || 'Genre', hints: [['A', 'Play'], ['B', 'Back']] });
      if (!g) return { shell: shell, content: emptyState('Genre not found', '', '') };
      return { shell: shell, title: g.name, content: playButtons('genre') + coll('genreSongs', g.tracks, { item: (t, i) => trackRow(t, i, false), open: (t, i) => playTracks(g.tracks, i) }) };
    },

    folder(r) {
      const crumbs = { music: 'Music › Folders', video: 'Videos › Folders', photo: 'Photos › Library' };
      const usbCrumbs = { music: 'Music › USB drive', video: 'Videos › USB drive', photo: 'Photos › USB drive' };
      const shell = sectionShell({ crumb: r.source === 'usb' ? usbCrumbs[r.kind] : crumbs[r.kind], title: r.title || 'Folder', hints: [['A', r.kind === 'photo' ? 'View' : 'Play'], ['B', 'Back']] });
      return { shell: shell, title: r.title, content: loading(), load: folderLoader(r.kind, r.source, r.id) };
    },

    usbAll(r) {
      const shell = sectionShell({ crumb: 'Music › USB drive', title: 'All music on this drive', hints: [['A', 'Play'], ['B', 'Back']] });
      return {
        shell: shell,
        content: '<div class="empty glass fade-in"><h2>Searching the drive…</h2><p>Reading song tags. Large drives and iPods can take a minute.</p><div class="spinner"></div></div>',
        load: async () => {
          const items = await Bridge.call('usbScan', { path: r.path, kind: 'audio', max: 8000 });
          const tracks = items.map(slimTrack).sort((x, y) => (x.artist || '').localeCompare(y.artist || '') || (x.album || '').localeCompare(y.album || '') || (x.track - y.track) || x.title.localeCompare(y.title));
          if (!tracks.length) return emptyState('No music found', 'This drive doesn’t have any music files WMC SX can play.', '');
          folderTracks = tracks;
          return '<div class="btn-row" style="margin-bottom:18px"><button class="btn cap f" data-act="playList" data-list="folder">Play all</button><button class="btn glass f" data-act="playList" data-list="folder" data-shuffle="1">Shuffle</button></div>' +
            coll('usbAll', tracks, { item: (t, i) => trackRow(t, i, false), open: (t, i) => playTracks(tracks, i) });
        }
      };
    },

    videos(r) {
      const view = r.view || 'all';
      const titles = { all: 'Movies', continue: 'Continue watching', folders: 'Folders', usb: 'USB drive', search: 'Search' };
      const out = {
        title: titles[view],
        shell: sectionShell({
          crumb: 'Home › Videos', title: titles[view] || 'Videos', active: view, search: 'Search videos', source: true,
          rail: [['all', 'Movies'], ['continue', 'Continue'], ['folders', 'Folders'], ['usb', 'USB drive']],
          hints: [['A', 'Play'], ['Y', 'Search'], ['B', 'Back']]
        })
      };
      if (view === 'folders') { out.content = loading(); out.load = folderLoader('video', 'dlna', null); return out; }
      if (view === 'usb') { out.content = loading(); out.load = folderLoader('video', 'usb', null); return out; }
      if (view === 'search') { out.content = searchHtml('videos'); return out; }
      if (view === 'continue') {
        const all = Resume.all();
        const list = Object.keys(all).map(u => Object.assign({ url: u }, all[u])).sort((a, b) => b.at - a.at);
        out.content = list.length ? coll('continue', list, {
          cols: 6,
          item: (v, i) => card(v, i, { cls: 'poster', art: v.art, seed: v.title, icon: 'film', t1: v.title || 'Video', t2: fmtTime(v.duration - v.position) + ' left', bar: v.duration ? v.position / v.duration : 0 }),
          open: (v, i) => playVideoIn(list, i)
        }) : emptyState('Nothing to continue', 'Videos you stop partway through will appear here so you can pick up where you left off.', '');
        return out;
      }
      const gate = libraryGate();
      if (gate) { out.content = gate; return out; }
      out.content = Lib.videos.length ? coll('videos', Lib.videos, { cols: 6, item: videoCard, open: (v, i) => playVideoIn(Lib.videos, i) })
        : emptyState('No videos found', 'Your media server didn’t share any videos. You can still browse its folders.', '<button class="btn cap f" data-act="view" data-v="folders">Browse folders</button>');
      return out;
    },

    photos(r) {
      const view = r.view || 'library';
      const out = {
        title: view === 'usb' ? 'USB drive' : 'Library',
        shell: sectionShell({ crumb: 'Home › Photos', title: view === 'usb' ? 'USB drive' : 'Library', active: view, source: true, rail: [['library', 'Library'], ['usb', 'USB drive']], hints: [['A', 'View'], ['B', 'Back']] }),
        content: loading(),
        load: folderLoader('photo', view === 'usb' ? 'usb' : 'dlna', null)
      };
      return out;
    },

    now() {
      const t = P.track;
      const shell = '<div class="sec-head"><button class="crumb enter" data-act="back">‹ Music › Now Playing</button><h1 class="title-in">Now Playing</h1></div>' +
        '<div class="np">' +
        '<div class="np-art enter" id="npArt" style="' + artBg(t && t.art, t && t.album) + '"></div>' +
        '<div class="np-info">' +
        '<div class="eq enter d1' + (P.state === 'playing' ? '' : ' paused') + '" id="npEq"><span class="b"></span><span class="b" style="animation-delay:-.3s"></span><span class="b" style="animation-delay:-.6s"></span><span class="b" style="animation-delay:-.15s"></span><span class="green" style="font-size:18px;font-weight:800;letter-spacing:1.5px;margin-left:10px;align-self:center">' + esc(Lib.server && t && t.url && t.url.indexOf('usb:') !== 0 ? 'PLAYING FROM ' + Lib.server.name.toUpperCase() : 'PLAYING') + '</span></div>' +
        '<div class="t1 enter d1" id="npTitle">' + esc(t ? t.title : 'Nothing playing') + '</div>' +
        '<div class="t2 enter d2" id="npArtist">' + esc(t ? t.artist : '') + '</div>' +
        '<div class="t3 enter d2" id="npAlbum">' + esc(t ? t.album : '') + '</div>' +
        '<div class="progress enter d3"><i id="npBar" style="width:' + pct() + '%"></i></div>' +
        '<div class="times enter d3"><span id="npPos">' + fmtTime(P.position) + '</span><span id="npDur">' + fmtTime(P.duration) + '</span></div>' +
        '<div class="controls enter d4">' +
        '<button class="orb small f' + (P.shuffle ? ' active' : '') + '" data-act="shuffle" data-k="np-shuffle" id="npShuffle" aria-label="Shuffle">' + SVG.shuffle + '</button>' +
        '<button class="orb f" data-act="prev" data-k="np-prev" aria-label="Previous">' + SVG.prev + '</button>' +
        '<button class="orb big f" data-act="toggle" data-k="np-play" id="npPlay" data-autofocus aria-label="Play or pause">' + (P.state === 'playing' ? SVG.pause : SVG.play) + '</button>' +
        '<button class="orb f" data-act="next" data-k="np-next" aria-label="Next">' + SVG.next + '</button>' +
        '<button class="orb small f' + (P.repeat !== 'off' ? ' active' : '') + '" data-act="repeat" data-k="np-repeat" id="npRepeat" aria-label="Repeat">' + (P.repeat === 'one' ? SVG.repeatOne : SVG.repeat) + '</button>' +
        '</div></div>' +
        '<div class="upnext glass enter d2"><h3>UP NEXT</h3><div id="npNext">' + upNextHtml() + '</div></div>' +
        '</div>' +
        '<div class="foot"><span></span>' + hintsHtml([['A', 'Select'], ['X', 'Play/Pause'], ['Y', 'Visualizer'], ['B', 'Back · keeps playing']]) + '</div>';
      return { shell: shell };
    },

    settings(r) {
      const view = r.view || 'sources';
      const titles = { sources: 'Sources', playback: 'Playback', colors: 'Colors', index: 'Library', about: 'About' };
      return {
        title: titles[view],
        shell: sectionShell({ crumb: 'Home › Settings', title: titles[view], active: view, rail: [['sources', 'Sources'], ['playback', 'Playback'], ['colors', 'Colors'], ['index', 'Library'], ['about', 'About']] }),
        content: settingsHtml(view)
      };
    }
  };

  function playButtons(list) {
    return '<div class="btn-row enter" style="margin-bottom:18px"><button class="btn cap f" data-act="playList" data-list="' + list + '">' + SVG.play.replace('<svg', '<svg width="22" height="22" style="fill:#fff"') + 'Play all</button><button class="btn glass f" data-act="playList" data-list="' + list + '" data-shuffle="1">Shuffle</button></div>';
  }
  function listFor(name) {
    if (name === 'songs') return Lib.tracks;
    if (name === 'album') { const a = Lib.albumMap.get(route.key); return a ? a.tracks : []; }
    if (name === 'artist') { const a = Lib.artists.find(x => x.name === route.name2); return a ? a.tracks : []; }
    if (name === 'genre') { const g = Lib.genres.find(x => x.name === route.name2); return g ? g.tracks : []; }
    if (name === 'folder') return folderTracks;
    if (name === 'search') return searchTracks;
    return [];
  }

  function upNextHtml() {
    const list = P.upNext || [];
    if (!list.length) return '<div class="dim" style="font-size:20px;padding:8px">Nothing queued after this.</div>';
    return list.slice(0, 7).map((t, i) => '<div class="row"><span class="n">' + (i + 1) + '</span><span class="thumb" style="' + artBg(t.art, t.album) + '"></span><span class="tt"><span class="t1">' + esc(t.title) + '</span><span class="t2">' + esc(t.artist || '') + '</span></span></div>').join('');
  }

  function tilesHtml(s) {
    return s.tiles.map((t, j) => '<button class="tile glass f menu-in d' + Math.min(5, j + 2) + '" data-act="tile" data-tile="' + j + '" data-k="tile-' + j + '"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true">' + ICONS[t[1]] + '</svg><span>' + esc(t[0]) + '</span></button>').join('');
  }
  function updateTiles() {
    const tiles = $('#tiles');
    if (!tiles) return;
    const hadFocus = cur && tiles.contains(cur);
    tiles.innerHTML = tilesHtml(SECTIONS[homeIdx]);
    if (hadFocus) setFocus(tiles.querySelector('.f'), { silent: true });
  }
  function onMenuFocus(i, silent) {
    if (i === homeIdx && $('#menuCap') && $('#menuCap').style.top === i * 104 + 'px') return;
    homeIdx = i;
    const cap = $('#menuCap');
    if (cap) cap.style.top = i * 104 + 'px';
    $$('.menu-btn').forEach((b, k) => b.classList.toggle('on', k === i));
    updateTiles();
    if (!silent) Sfx.play('move', i);
    saveNav();
  }

  /* ---------------- Search */
  function searchHtml(kind) {
    return '<div id="searchResults">' + searchResults(kind) + '</div>';
  }
  function searchResults(kind) {
    const q = route.q || '';
    if (!q.trim()) return emptyState('Search', kind === 'music' ? 'Choose the search box and type an artist, album or song.' : 'Choose the search box and type part of a video’s name.', '<button class="btn cap f" data-act="focusSearch">Start typing</button>');
    const gate = libraryGate();
    if (gate) return gate;
    const res = Lib.search(q);
    if (kind === 'videos') {
      return res.videos.length ? coll('searchVideos', res.videos, { cols: 6, item: videoCard, open: (v, i) => playVideoIn(res.videos, i) }) : emptyState('No matches', 'No videos match “' + q + '”.', '');
    }
    searchTracks = res.tracks;
    let h = '';
    if (res.albums.length) h += '<h2 style="font-size:28px;margin:6px 0 16px">Albums</h2>' + coll('searchAlbums', res.albums, { cols: 5, item: albumCard, open: a => go({ name: 'album', key: a.key }) });
    if (res.tracks.length) h += '<h2 style="font-size:28px;margin:30px 0 16px">Songs</h2>' + coll('searchSongs', res.tracks, { item: (t, i) => trackRow(t, i, false), open: (t, i) => playTracks(res.tracks, i) });
    return h || emptyState('No matches', 'Nothing in your music matches “' + q + '”.', '');
  }
  function renderSearchResults() {
    const box = $('#searchResults');
    if (!box) return;
    box.innerHTML = searchResults(route.name === 'videos' ? 'videos' : 'music');
  }
  document.addEventListener('input', e => {
    if (e.target && e.target.id === 'searchBox') {
      route.q = e.target.value;
      if (route.view !== 'search') {
        route = Object.assign({}, route, { view: 'search' });
        $$('.rail[data-v]').forEach(el => el.classList.remove('cap'));
        const h = $('.sec-head h1'); if (h) h.textContent = 'Search';
        const box = $('#content'); if (box) box.innerHTML = searchHtml(route.name === 'videos' ? 'videos' : 'music');
      }
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderSearchResults, 250);
      saveNav();
    }
  });
  let searchTimer = 0;

  /* ---------------- Settings */
  function settingsHtml(view) {
    if (view === 'sources') {
      const list = Array.from(Lib.servers.values());
      const servers = list.length ? list.map((s, i) => {
        const on = Lib.server && Lib.server.id === s.id;
        return '<button class="server f enter d' + Math.min(5, i + 1) + '" data-act="useServer" data-id="' + esc(s.id) + '" data-k="srv-' + i + '">' +
          '<span class="ic">' + (s.icon ? '<img alt="" src="' + esc(mediaUrl(s.icon)) + '">' : ico('server', '')) + '</span>' +
          '<span class="tt"><span class="t1">' + esc(s.name) + '</span><span class="t2">DLNA media server · ' + esc(s.host || '') + (s.model ? ' · ' + esc(s.model) : '') + '</span></span>' +
          '<span class="chip">Music</span><span class="chip">Videos</span><span class="chip">Photos</span>' +
          '<span class="state ' + (on ? 'green' : 'dim') + '"><span class="dot' + (on ? '' : ' off') + '"></span>' + (on ? 'Connected' : 'Use this') + '</span></button>';
      }).join('') : '<div class="note">No media servers found yet. Make sure your NAS’s media server (DLNA) is turned on and the Xbox is on the same network.</div>';
      return '<div class="panel glass enter d1"><div class="head"><h2>Media servers on your network</h2><div class="btn-row"><button class="btn cap f" data-act="discover" data-k="discover">' + (discovering ? '<span class="spinner"></span>Searching…' : 'Find my NAS') + '</button></div></div>' + servers +
        '<div class="note">Other media servers on your network appear here automatically.</div></div>' +
        '<div class="panel glass enter d2"><h2>Add by address</h2><div class="kv">If your NAS doesn’t show up, enter its IP address (for example 192.168.1.20).</div>' +
        '<div class="field"><input class="f" id="ipBox" data-k="ip" placeholder="192.168.1.20" inputmode="decimal" value="' + esc(Store.get('lastIp', '')) + '"><button class="btn glass f" data-act="probe" data-k="probe">Connect</button></div></div>';
    }
    if (view === 'playback') {
      const toggle = (key, label, sub) => '<button class="toggle f' + (prefs[key] ? ' on' : '') + '" data-act="pref" data-pref="' + key + '" data-k="pref-' + key + '"><span><span style="display:block">' + esc(label) + '</span><span class="dim" style="font-size:18px;font-weight:500">' + esc(sub) + '</span></span><span class="sw"></span></button>';
      return '<div class="panel glass enter d1"><h2>Playback</h2>' +
        toggle('sound', 'Menu sounds', 'Soft chimes when you move around the menus (quiet while music plays)') +
        toggle('intro', 'Startup animation', 'Play the welcome animation and sound when WMC SX opens') +
        toggle('resume', 'Resume videos', 'Pick up videos where you left off') +
        '</div><div class="panel glass enter d2"><h2>Continue watching</h2><div class="kv">' + Object.keys(Resume.all()).length + ' videos saved partway through.</div><div class="btn-row"><button class="btn glass f" data-act="clearResume">Clear the list</button></div></div>';
    }
    if (view === 'colors') {
      const sw = THEMES.map((t, i) => {
        const c = Theme.preview(t), on = Theme.current === t.id;
        return '<button class="swatch f enter d' + Math.min(5, i + 1) + (on ? ' on' : '') + '" data-act="theme" data-theme="' + t.id + '" data-k="theme-' + t.id + '"' + (on ? ' data-autofocus' : '') + '>' +
          '<span class="sw-sky" style="background:radial-gradient(ellipse 120% 90% at 20% 0%,' + c.glow + ' 0%,transparent 65%),linear-gradient(160deg,' + c.bg1 + ',' + c.bg2 + ')">' +
          '<span class="sw-pill" style="background:linear-gradient(180deg,rgba(255,255,255,.45) 0%,rgba(255,255,255,.1) 48%,rgba(255,255,255,0) 50%),linear-gradient(180deg,' + c.cap1 + ',' + c.cap2 + ')"></span>' +
          '<span class="sw-ring" style="border-color:' + c.focus + ';box-shadow:0 0 14px ' + c.focus + '"></span></span>' +
          '<span class="sw-name">' + esc(t.name) + '</span><span class="sw-on">' + (on ? 'In use' : '') + '</span></button>';
      }).join('');
      return '<div class="panel glass enter d1"><h2>Menu colors</h2><div class="kv">Changes the glass, highlights and background. Album art, photos and videos keep their own colors.</div>' +
        '<div class="swatches">' + sw + '</div></div>';
    }
    if (view === 'index') {
      const when = Lib.builtAt ? new Date(Lib.builtAt).toLocaleString() : 'never';
      return '<div class="panel glass enter d1"><h2>Library</h2>' +
        '<div class="kv"><b>' + Lib.tracks.length + '</b> songs · <b>' + Lib.albums.length + '</b> albums · <b>' + Lib.artists.length + '</b> artists · <b>' + Lib.videos.length + '</b> videos</div>' +
        '<div class="kv">Source: <b>' + esc(Lib.server ? Lib.server.name : 'not connected') + '</b> · Last updated: <b>' + esc(when) + '</b></div>' +
        (Lib.building ? '<div class="field"><span class="spinner"></span><span class="kv" data-progress>' + esc(Lib.progress || 'Scanning…') + '</span></div>' : '') +
        '<div class="kv dim">WMC SX scans your media server’s folders to build its own search index. It refreshes automatically once a day.</div>' +
        '<div class="btn-row"><button class="btn cap f" data-act="rebuild"' + (Lib.server ? '' : ' disabled') + '>' + (Lib.building ? 'Scanning…' : 'Rebuild library') + '</button></div></div>';
    }
    return '<div class="panel glass enter d1"><h2>WMC SX</h2><div class="kv">Version <b id="aboutVersion">' + esc(appInfo.version || '1.0') + '</b> · ' + esc(appInfo.device || '') + '</div>' +
      '<div class="kv">Music, videos and photos from your NAS (DLNA) and USB drives. Music keeps playing in the background while you use other apps in Dev Mode.</div></div>' +
      '<div class="panel glass enter d2"><h2>Controller</h2><div class="kv"><b>A</b> select · <b>B</b> back · <b>X</b> play/pause · <b>Y</b> search (visualizer on Now Playing) · <b>LB/RB</b> previous/next song · <b>LT/RT</b> back 10s / ahead 30s · <b>Menu</b> Now Playing · <b>View</b> home</div></div>' +
      '<div class="panel glass enter d3"><h2>Diagnostics</h2><div class="kv">If something isn’t working, the app’s log shows what happened, newest first. ' + (appInfo.memory ? 'Memory: ' + esc(appInfo.memory) + '.' : '') + '</div>' +
      '<div class="btn-row"><button class="btn glass f" data-act="showLog" data-k="showLog">' + (logText && !logPrev ? 'Refresh log' : 'Show log') + '</button>' +
      '<button class="btn glass f" data-act="showPrevLog" data-k="showPrevLog">Last time’s log</button></div>' +
      '<div class="kv dim">After a crash, reopen WMC SX and choose “Last time’s log”: it shows what happened before the app closed.</div>' +
      (logText ? '<div class="kv"><b>' + (logPrev ? 'Last time’s log' : 'This time’s log') + '</b></div>' : '') +
      (logText ? '<div class="kv dim">Scroll the log with up and down on the left stick or d-pad.</div><pre class="logbox f" data-k="logbox" data-scroll>' + esc(logText) + '</pre>' : '') + '</div>';
  }
  let discovering = false;
  let appInfo = {};
  let logText = '';
  let logPrev = false;
  function showLogText(previous) {
    return Promise.all([Bridge.call('readLog', { previous: previous }), Bridge.call('info', {})])
      .then(([t, info]) => {
        logPrev = previous;
        logText = t ? String(t).split('\n').reverse().join('\n') : '(empty)';
        appInfo = Object.assign(appInfo, info || {});
        refreshIf(['settings']);
        // Bring the whole log into view and put focus on it, so up/down scroll it right away.
        const box = $('#screen .logbox');
        if (box) { box.scrollTop = 0; setFocus(box); }
      })
      .catch(e => toast('Couldn’t read the log. ' + e.message));
  }

  /* ================================================================ Actions */
  const Actions = {
    back: () => back(),
    now: () => { if (P.track) go({ name: 'now' }); },
    section: el => { const s = SECTIONS[+el.dataset.menu]; go(Object.assign({}, s.tiles[0][2])); },
    tile: el => { const t = SECTIONS[homeIdx].tiles[+el.dataset.tile]; go(Object.assign({}, t[2])); },
    view: el => setView(el.dataset.v),
    go: el => { const p = el.dataset.route.split(':'); go({ name: p[0], view: p[1] }); },
    focusSearch: () => { const s = $('#searchBox'); if (s) { setFocus(s.closest('.f')); s.focus(); } },
    playList: el => { const list = listFor(el.dataset.list); if (!list.length) return; const shuffle = !!el.dataset.shuffle; playTracks(list, shuffle ? Math.floor(Math.random() * list.length) : 0, shuffle); },
    usbScan: el => go({ name: 'usbAll', path: el.dataset.path }),
    toggle: () => control('toggle'),
    prev: () => control('prev'),
    next: () => control('next'),
    shuffle: () => { Sfx.play('move', 0); control('shuffle', P.shuffle ? 0 : 1); },
    repeat: () => { Sfx.play('move', 3); const nextMode = P.repeat === 'off' ? 1 : P.repeat === 'all' ? 2 : 0; control('repeat', nextMode); toast(['Repeat off', 'Repeat all', 'Repeat this song'][nextMode], 1500); },
    refresh: () => refreshIf([route.name]),
    discover: () => {
      discovering = true; refreshIf(['settings']);
      Bridge.call('discover').catch(() => {});
      setTimeout(() => { discovering = false; refreshIf(['settings']); if (!Lib.servers.size) toast('No media server answered. Check that DLNA is turned on on your NAS.'); }, 4500);
    },
    probe: () => {
      const ip = ($('#ipBox') || {}).value || '';
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip.trim())) { toast('Enter an IP address like 192.168.1.20'); return; }
      Store.set('lastIp', ip.trim());
      toast('Asking ' + ip.trim() + '…', 2500);
      Bridge.call('probe', { ip: ip.trim() }).catch(() => {});
      setTimeout(() => { if (!Array.from(Lib.servers.values()).some(s => s.host === ip.trim())) toast('No media server answered at ' + ip.trim() + '.'); }, 4000);
    },
    useServer: el => { const s = Lib.servers.get(el.dataset.id); if (s && (!Lib.server || Lib.server.id !== s.id)) Lib.select(s, true).then(() => refreshIf(['settings'])); },
    theme: el => {
      const t = Theme.apply(el.dataset.theme);
      prefs.theme = t.id; savePrefs();
      $$('.swatch').forEach(b => { const on = b.dataset.theme === t.id; b.classList.toggle('on', on); b.querySelector('.sw-on').textContent = on ? 'In use' : ''; });
    },
    pref: el => { const k = el.dataset.pref; prefs[k] = !prefs[k]; savePrefs(); el.classList.toggle('on', prefs[k]); if (k === 'sound' && prefs.sound) Sfx.play('select'); },
    showLog: () => showLogText(false),
    showPrevLog: () => showLogText(true),
    clearResume: () => { Resume.clear(); toast('Continue watching cleared'); refreshIf(['settings']); },
    rebuild: () => { if (Lib.server && !Lib.building) { Lib.buildIndex(); refreshIf(['settings']); } },
    noop: () => {}
  };

  /* ================================================================ Live player updates */
  function updatePlayerUi(trackChanged) {
    const t = P.track;
    const mini = $('#mini');
    if (mini) {
      mini.style.visibility = t && P.state !== 'stopped' ? '' : 'hidden';
      if (trackChanged) {
        $('#miniArt').setAttribute('style', artBg(t && t.art, t && t.album));
        $('#miniTitle').textContent = t ? t.title : '';
        $('#miniSub').textContent = t ? [t.artist, t.album].filter(Boolean).join(' · ') : '';
      }
      $('#miniLabel').textContent = P.state === 'paused' ? 'PAUSED' : 'NOW PLAYING';
      $('#miniBar').style.width = pct() + '%';
    }
    if (route.name === 'now') {
      if (trackChanged) {
        $('#npArt').setAttribute('style', artBg(t && t.art, t && t.album));
        $('#npTitle').textContent = t ? t.title : 'Nothing playing';
        $('#npArtist').textContent = t ? t.artist : '';
        $('#npAlbum').textContent = t ? t.album : '';
        $('#npNext').innerHTML = upNextHtml();
      }
      $('#npBar').style.width = pct() + '%';
      $('#npPos').textContent = fmtTime(P.position);
      $('#npDur').textContent = fmtTime(P.duration);
      $('#npPlay').innerHTML = P.state === 'playing' ? SVG.pause : SVG.play;
      $('#npEq').classList.toggle('paused', P.state !== 'playing');
      $('#npShuffle').classList.toggle('active', !!P.shuffle);
      const rep = $('#npRepeat');
      rep.classList.toggle('active', P.repeat !== 'off');
      rep.innerHTML = P.repeat === 'one' ? SVG.repeatOne : SVG.repeat;
      if (!trackChanged) $('#npNext').innerHTML = upNextHtml();
    }
    if (trackChanged) {
      $$('.row.playing').forEach(r => r.classList.remove('playing'));
    }
  }

  /* ================================================================ Photo viewer */
  const Viewer = {
    open: false, list: [], i: 0, timer: 0, front: 'A', infoTimer: 0, token: 0,
    show(list, i) {
      this.list = list; this.i = Math.max(0, i); this.open = true;
      $('#viewer').classList.remove('hidden');
      this.draw(true);
      Sfx.play('select');
    },
    draw(first) {
      const it = this.list[this.i];
      if (!it) return;
      const next = this.front === 'A' ? 'B' : 'A';
      const img = $('#viewer' + next), old = $('#viewer' + this.front);
      // Show the small tile picture right away (already saved on the console), then swap in the
      // full photo when it's ready. Tries the server's JPEG copy, then the original, then the preview.
      const tries = [it.view, it.url, it.thumb].filter((u, k, arr) => u && arr.indexOf(u) === k);
      const tile = it.thumb || it.view || it.art || it.url;
      const token = ++this.token;
      const shown = () => { $('#viewerMsg').classList.add('hidden'); img.classList.add('show'); old.classList.remove('show'); };
      $('#viewerMsg').classList.add('hidden');
      img.onload = shown;
      img.onerror = null;
      if (tile) img.src = mediaUrl(tile, ART_SIZE) || tile;
      const loadFull = () => {
        if (token !== this.token) return;
        if (!tries.length) {
          if (!img.getAttribute('src') || !img.complete || !img.naturalWidth) {
            img.removeAttribute('src'); old.classList.remove('show');
            $('#viewerMsg').classList.remove('hidden');
          }
          return;
        }
        const u = tries.shift();
        const full = new Image();
        full.onload = () => { if (token === this.token) { img.onload = shown; img.src = full.src; } };
        full.onerror = loadFull;
        full.src = mediaUrl(u) || u;
      };
      loadFull();
      this.front = next;
      if (first) old.classList.remove('show');
      const info = this.info();
      info.classList.remove('gone');
      clearTimeout(this.infoTimer);
      this.infoTimer = setTimeout(() => info.classList.add('gone'), 3000);
      const pre = this.list[this.i + 1];
      if (pre) { const pu = pre.view || pre.url; const p = new Image(); p.src = mediaUrl(pu) || pu; }
    },
    // "12 of 30,214 · IMG_1012". The total grows while a big folder is still loading.
    info() {
      const el = $('#viewerInfo'), it = this.list[this.i];
      if (it) el.textContent = (this.i + 1).toLocaleString() + ' of ' + this.list.length.toLocaleString() + ' · ' + (it.title || '') + (this.timer ? ' · Slideshow' : '') + ' · A slideshow · B close';
      return el;
    },
    step(d) {
      if (!this.list.length) return;
      this.i = (this.i + d + this.list.length) % this.list.length;
      Sfx.play('tick', this.i);
      this.draw(false);
    },
    toggleShow() {
      if (this.timer) { clearInterval(this.timer); this.timer = 0; toast('Slideshow paused', 1400); }
      else { this.timer = setInterval(() => { this.i = (this.i + 1) % this.list.length; this.draw(false); }, 6000); toast('Slideshow', 1400); }
    },
    close() {
      clearInterval(this.timer); this.timer = 0;
      this.open = false; this.token++;
      $('#viewer').classList.add('hidden');
      $('#viewerA').classList.remove('show'); $('#viewerB').classList.remove('show');
      $('#viewerA').removeAttribute('src'); $('#viewerB').removeAttribute('src');
      $('#viewerMsg').classList.add('hidden');
      Sfx.play('back');
    }
  };

  /* ================================================================ Music visualizer */
  // The music plays in the native player, so the page can't listen to it live. Instead, when the
  // visualizer opens, the song file is read once and mapped out: how loud the bass, middle and
  // treble are 60 times a second, and where the beats fall. The picture then follows the
  // player's position, so it moves on the beat.
  function audioUrl(u) {
    if (!u) return '';
    if (!native) return window.WmcMock && WmcMock.audioUrl ? WmcMock.audioUrl(u) : '';
    if (u.indexOf('usb:') === 0) return 'https://full.wmcsx/usbfile?p=' + encodeURIComponent(u.slice(4));
    return 'https://full.wmcsx/audio?u=' + encodeURIComponent(u);
  }
  const Beats = {
    cache: new Map(), // song url -> map, or 'none' when it can't be read
    get(url) { const m = this.cache.get(url); return m && m !== 'none' && !m.then ? m : null; },
    load(t) {
      if (!t || !t.url) return Promise.resolve(null);
      const had = this.cache.get(t.url);
      if (had) return had.then ? had : Promise.resolve(had === 'none' ? null : had);
      // Very long tracks would need too much memory to decode on the console.
      if (t.duration && t.duration > 900) { this.cache.set(t.url, 'none'); return Promise.resolve(null); }
      const job = this.analyse(t.url).then(m => { this.keep(t.url, m || 'none'); return m; }, e => {
        nativeLog('visualizer: couldn’t map the beats, ' + (e && e.message ? e.message : e));
        this.keep(t.url, 'none');
        return null;
      });
      this.cache.set(t.url, job);
      return job;
    },
    keep(url, m) {
      this.cache.delete(url);
      this.cache.set(url, m);
      while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value);
    },
    async analyse(url) {
      const src = audioUrl(url);
      if (!src) return null;
      const res = await fetch(src);
      if (!res.ok) return null;
      let data = await res.arrayBuffer();
      const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!AC) return null;
      // Decoding at a low sample rate keeps memory small; beats live in the low end anyway.
      const audio = await new AC(1, 11025, 11025).decodeAudioData(data);
      data = null;
      const sr = audio.sampleRate, n = audio.length;
      const c0 = audio.getChannelData(0), c1 = audio.numberOfChannels > 1 ? audio.getChannelData(1) : null;
      const FPS = 60, hop = Math.max(1, Math.round(sr / FPS)), frames = Math.floor(n / hop);
      const bass = new Float32Array(frames), mid = new Float32Array(frames), high = new Float32Array(frames);
      const aB = Math.exp(-2 * Math.PI * 150 / sr), aM = Math.exp(-2 * Math.PI * 1800 / sr);
      let lb = 0, lm = 0, sb = 0, sm = 0, sh = 0, f = 0, k = 0;
      for (let i = 0; i < n && f < frames; i++) {
        const x = c1 ? (c0[i] + c1[i]) * 0.5 : c0[i];
        lb += (1 - aB) * (x - lb);
        lm += (1 - aM) * (x - lm);
        sb += lb * lb; sm += (lm - lb) * (lm - lb); sh += (x - lm) * (x - lm);
        if (++k === hop) { bass[f] = Math.sqrt(sb / hop); mid[f] = Math.sqrt(sm / hop); high[f] = Math.sqrt(sh / hop); f++; k = 0; sb = sm = sh = 0; }
      }
      // Scale each band so a loud passage is about 1.
      const norm = a => {
        const step = Math.max(1, Math.floor(a.length / 4000)), s = [];
        for (let i = 0; i < a.length; i += step) s.push(a[i]);
        s.sort((x, y) => x - y);
        const top = s[Math.floor(s.length * 0.95)] || 1;
        for (let i = 0; i < a.length; i++) a[i] = Math.min(1.6, a[i] / top);
      };
      norm(bass); norm(mid); norm(high);
      // Beats: sudden rises in the bass (and a little of the middle), above the local average.
      const flux = new Float32Array(frames);
      for (let i = 6; i < frames; i++) {
        let pb = 0, pm = 0;
        for (let j = 1; j <= 6; j++) { pb += bass[i - j]; pm += mid[i - j]; }
        flux[i] = Math.max(0, bass[i] - pb / 6) + 0.35 * Math.max(0, mid[i] - pm / 6);
      }
      const beats = [];
      const W = 30, gap = Math.round(FPS * 0.24);
      let sum = 0;
      for (let i = 0; i < Math.min(frames, W * 2); i++) sum += flux[i];
      let last = -gap;
      for (let i = 0; i < frames; i++) {
        const lo = i - W - 1, hi = i + W;
        if (lo >= 0) sum -= flux[lo];
        if (hi < frames && hi >= W * 2) sum += flux[hi];
        const avg = sum / (W * 2);
        const v = flux[i];
        if (v > avg * 1.7 + 0.05 && i - last >= gap) {
          let peak = true;
          for (let j = Math.max(0, i - 4); j <= Math.min(frames - 1, i + 4); j++) if (flux[j] > v) { peak = false; break; }
          if (peak) { beats.push(i / FPS); last = i; }
        }
      }
      return { fps: FPS, frames: frames, bass: bass, mid: mid, high: high, beats: new Float32Array(beats) };
    }
  };

  const VIZ_STYLES = ['Kaleidoscope', 'Tunnel', 'Liquid'];
  const VIZ_FRAG = [
    'precision mediump float;',
    'uniform vec2 R; uniform float T, bass, mid, high, pulse, wave, mode, hue, travel;',
    'vec3 pal(float t){ return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.18, 0.42))); }',
    'float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
    'float n2(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(h(i), h(i + vec2(1.0, 0.0)), f.x), mix(h(i + vec2(0.0, 1.0)), h(i + vec2(1.0, 1.0)), f.x), f.y); }',
    'float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * n2(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; } return v; }',
    'void main(){',
    '  vec2 uv = (gl_FragCoord.xy - 0.5 * R) / R.y;',
    '  uv *= 1.0 - 0.16 * bass - 0.1 * pulse;',
    '  float r = length(uv), a = atan(uv.y, uv.x);',
    '  vec3 c;',
    '  if (mode < 0.5) {',
    // Kaleidoscope: an 8-way mirror over swirling, self-warping clouds.
    '    float k = 8.0, s = 6.28318 / k;',
    '    float b = mod(a + T * 0.08 + 0.3 * sin(T * 0.13), s); b = abs(b - s * 0.5);',
    '    vec2 p = r * vec2(cos(b), sin(b)) * (2.2 + mid * 0.6);',
    '    vec2 q = vec2(fbm(p + T * 0.12), fbm(p - T * 0.1 + 4.0));',
    '    float f = fbm(p * 1.6 + 2.6 * q + vec2(T * 0.08, -T * 0.05) + bass * 0.6);',
    '    c = pal(f * 1.6 + hue + r * 0.7 - T * 0.04);',
    '    c *= 0.35 + 1.1 * f * f + 0.25 * bass;',
    '    c += pal(hue + 0.5) * pow(max(0.0, 1.0 - abs(f - 0.55) * 9.0), 3.0) * (0.4 + high);',
    '  } else if (mode < 1.5) {',
    // Tunnel: flying down a striped, twisting tube.
    '    float z = 0.42 / (r + 0.03) + travel;',
    '    float tw = a + 0.35 * sin(z * 0.6 + T * 0.4);',
    // Noise is read around a circle so there is no seam where the angle wraps.
    '    vec2 cyl = vec2(cos(tw), sin(tw)) * 1.6;',
    '    float f = fbm(cyl + vec2(z * 0.9, -z * 0.6));',
    '    float rings = smoothstep(0.15, 0.85, 0.5 + 0.5 * sin(z * 5.0 + f * 3.0));',
    '    float spokes = smoothstep(0.2, 0.9, 0.5 + 0.5 * sin(tw * 6.0 + z * 1.5 + T * 0.6));',
    '    c = pal(z * 0.05 + f * 0.8 + hue + 0.12 * sin(tw)) * (0.25 + 0.9 * rings * (0.4 + 0.6 * spokes) + 0.35 * f);',
    '    c *= smoothstep(0.0, 0.55, r) * (0.8 + 0.6 * bass);',
    '    c += vec3(1.0, 0.8, 0.55) * 0.5 * pulse * smoothstep(0.35, 0.0, r);',
    '  } else {',
    // Liquid: melting, chromatic plasma.
    '    vec2 p = uv * (2.4 + mid);',
    '    for (int i = 1; i < 7; i++) { float fi = float(i);',
    '      p.x += 0.45 / fi * sin(fi * p.y + T * 0.55 + bass * 1.8 + fi);',
    '      p.y += 0.45 / fi * cos(fi * p.x + T * 0.45 - high + fi * 1.3); }',
    '    float f = 0.5 + 0.5 * sin(p.x + p.y);',
    '    c = vec3(pal(f + hue).r, pal(f + hue + 0.03 + 0.04 * high).g, pal(f + hue + 0.06 + 0.06 * high).b);',
    '    c *= 0.55 + 0.6 * f + 0.25 * bass;',
    '  }',
    // A ring of light rolls out from the middle on every beat.
    '  float ring = exp(-pow((r - wave * 1.25) * 9.0, 2.0)) * exp(-wave * 2.6);',
    '  c += pal(hue + 0.15) * ring * 1.4;',
    '  c += c * pulse * 0.35;',
    '  c *= 1.0 - 0.55 * smoothstep(0.55, 1.15, length((gl_FragCoord.xy - 0.5 * R) / R.y * vec2(0.9, 1.1)));',
    '  gl_FragColor = vec4(pow(clamp(c, 0.0, 1.0), vec3(0.92)), 1.0);',
    '}'
  ].join('\n');

  const Viz = {
    open: false, gl: null, prog: null, u: {}, raf: 0, style: Store.get('vizStyle', 0) % VIZ_STYLES.length,
    map: null, url: null, t0: 0, travel: 0, lastT: 0,
    lvl: { bass: 0, mid: 0, high: 0 }, hueBase: Math.random(), hueKick: 0, lastBeat: -1,
    clock: { pos: 0, at: 0 }, infoTimer: 0, hintTimer: 0,
    show() {
      if (this.open) return;
      this.open = true;
      $('#viz').classList.remove('hidden');
      if (!this.gl && !this.init()) { this.open = false; $('#viz').classList.add('hidden'); toast('This console can’t draw the visualizer.'); return; }
      this.t0 = performance.now(); this.lastT = 0; this.perf = { sum: 0, n: 0 };
      this.sync();
      this.track(true);
      this.hint('A next style · X play/pause · LB/RB song · B close', 4500);
      Sfx.play('select');
      this.raf = requestAnimationFrame(t => this.frame(t));
    },
    close() {
      if (!this.open) return;
      this.open = false;
      cancelAnimationFrame(this.raf);
      $('#viz').classList.add('hidden');
      // Give the graphics memory back.
      try { const ext = this.gl && this.gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); } catch (e) { /* ignore */ }
      this.gl = null; this.prog = null;
      Sfx.play('back');
    },
    init() {
      const cv = $('#vizCanvas');
      const gl = cv.getContext('webgl', { antialias: false, alpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' }) ||
        cv.getContext('experimental-webgl');
      if (!gl) return false;
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { nativeLog('visualizer shader: ' + gl.getShaderInfoLog(s)); return null; } return s; };
      const vs = sh(gl.VERTEX_SHADER, 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }');
      const fs = sh(gl.FRAGMENT_SHADER, VIZ_FRAG);
      if (!vs || !fs) return false;
      const pr = gl.createProgram();
      gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return false;
      gl.useProgram(pr);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(pr, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      ['R', 'T', 'bass', 'mid', 'high', 'pulse', 'wave', 'mode', 'hue', 'travel'].forEach(n => { this.u[n] = gl.getUniformLocation(pr, n); });
      cv.width = Math.round(960 * this.scale); cv.height = Math.round(540 * this.scale);
      gl.viewport(0, 0, cv.width, cv.height);
      this.gl = gl; this.prog = pr;
      return true;
    },
    // The player reports its position once a second; in between, count forward ourselves.
    sync() {
      const now = performance.now();
      const est = this.pos(now);
      const diff = P.position - est;
      this.clock = { pos: Math.abs(diff) > 0.3 || P.state !== 'playing' ? P.position : est + diff * 0.3, at: now };
    },
    pos(now) { return this.clock.pos + (P.state === 'playing' ? (now - this.clock.at) / 1000 : 0); },
    track(force) {
      const t = P.track;
      if (!t) return;
      if (!force && t.url === this.url) return;
      this.url = t.url; this.map = null; this.lastBeat = -1;
      $('#vizTitle').textContent = t.title || '';
      $('#vizSub').textContent = [t.artist, t.album].filter(Boolean).join(' · ');
      const info = $('#vizInfo');
      info.classList.remove('gone');
      clearTimeout(this.infoTimer);
      this.infoTimer = setTimeout(() => info.classList.add('gone'), 5000);
      const url = t.url;
      this.map = Beats.get(url);
      if (!this.map) Beats.load(t).then(m => { if (this.url === url) this.map = m; });
    },
    hint(text, ms) {
      const h = $('#vizHint');
      h.textContent = text; h.classList.remove('gone');
      clearTimeout(this.hintTimer);
      this.hintTimer = setTimeout(() => h.classList.add('gone'), ms || 2500);
    },
    nextStyle(d) {
      this.style = (this.style + (d || 1) + VIZ_STYLES.length) % VIZ_STYLES.length;
      Store.set('vizStyle', this.style);
      this.hint(VIZ_STYLES[this.style], 1800);
    },
    frame(now) {
      if (!this.open || !this.gl) return;
      this.raf = requestAnimationFrame(t => this.frame(t));
      const gl = this.gl, u = this.u;
      const T = (now - this.t0) / 1000, dt = Math.min(0.1, T - this.lastT);
      this.lastT = T;
      this.adapt(dt);
      const playing = P.state === 'playing';
      const pos = this.pos(now);
      let tb, tm, th, pulse = 0, wave = 9;
      const m = this.map;
      if (m && m.frames) {
        const i = Math.max(0, Math.min(m.frames - 1, Math.floor(pos * m.fps)));
        tb = m.bass[i]; tm = m.mid[i]; th = m.high[i];
        // Time since the most recent beat.
        let lo = 0, hi = m.beats.length - 1, b = -1;
        while (lo <= hi) { const c = (lo + hi) >> 1; if (m.beats[c] <= pos) { b = c; lo = c + 1; } else hi = c - 1; }
        if (b >= 0) {
          const since = pos - m.beats[b];
          pulse = Math.exp(-since * 7); wave = since;
          if (b !== this.lastBeat) { this.lastBeat = b; this.hueKick += 0.06 + 0.05 * Math.min(1, tb); }
        }
      } else {
        // Song not mapped (yet, or a format the console can't read): drift gently instead.
        tb = 0.35 + 0.15 * Math.sin(T * 1.7); tm = 0.4 + 0.1 * Math.sin(T * 0.9); th = 0.3;
      }
      if (!playing) { tb *= 0.3; tm *= 0.3; th *= 0.3; pulse = 0; }
      // Fast attack, slower release, so the motion punches without jitter.
      const ease = (cur, target, up, down) => cur + (target - cur) * Math.min(1, dt * (target > cur ? up : down));
      const L = this.lvl;
      L.bass = ease(L.bass, tb, 22, 6); L.mid = ease(L.mid, tm, 14, 5); L.high = ease(L.high, th, 18, 6);
      this.travel += dt * (0.35 + 1.6 * L.bass + 0.6 * L.mid) * (playing ? 1 : 0.25);
      gl.uniform2f(u.R, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.uniform1f(u.T, T); gl.uniform1f(u.bass, L.bass); gl.uniform1f(u.mid, L.mid); gl.uniform1f(u.high, L.high);
      gl.uniform1f(u.pulse, pulse); gl.uniform1f(u.wave, wave); gl.uniform1f(u.mode, this.style);
      gl.uniform1f(u.hue, this.hueBase + T * 0.012 + this.hueKick); gl.uniform1f(u.travel, this.travel);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    // Keep it smooth: draw fewer pixels if frames are slow, more again when there's room.
    // (It's soft and blurry by nature, so a lower resolution barely shows.)
    perf: { sum: 0, n: 0 }, scale: 1,
    adapt(dt) {
      const pf = this.perf;
      if (!dt) return;
      pf.sum += dt; pf.n++;
      if (pf.n < 30 && pf.sum < 1) return;
      const avg = pf.sum / pf.n;
      pf.sum = 0; pf.n = 0;
      let k = this.scale;
      if (avg > 1 / 45 && k > 0.34) k = Math.max(0.33, k * 0.75);
      else if (avg < 1 / 58 && k < 1) k = Math.min(1, k * 1.15);
      if (k === this.scale) return;
      this.scale = k;
      const cv = $('#vizCanvas');
      cv.width = Math.round(960 * k); cv.height = Math.round(540 * k);
      this.gl.viewport(0, 0, cv.width, cv.height);
    },
    handle(action) {
      switch (action) {
        case 'b': case 'y': this.close(); return true;
        case 'a': case 'right': this.nextStyle(1); return true;
        case 'left': this.nextStyle(-1); return true;
        case 'up': case 'down': case 'menu': return true;
        case 'view': this.close(); return false;
      }
      return false; // X, LB/RB, LT/RT work as usual
    }
  };
  Bridge.on('player', () => { if (Viz.open) { Viz.sync(); Viz.track(false); } });
  if (!native) window.WmcDebug = { Viz: Viz, Beats: Beats }; // browser preview only, for testing

  /* ================================================================ Clock and scaling */
  function clockText() { return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function tickClock() {
    const c = $('#clock'); if (c) c.textContent = clockText();
    const h = $('#clockHome'); if (h) h.textContent = clockText();
  }
  function fit() {
    const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    stage.style.transform = 'translate(' + ((window.innerWidth - 1920 * s) / 2) + 'px,' + ((window.innerHeight - 1080 * s) / 2) + 'px) scale(' + s + ')';
  }

  /* ================================================================ Start */
  async function start() {
    if (!native) {
      await new Promise(res => { const s = document.createElement('script'); s.src = 'mock.js'; s.onload = res; s.onerror = res; document.head.appendChild(s); });
      if (!window.WmcMock) { document.body.textContent = 'mock.js missing'; return; }
    }
    Theme.apply(prefs.theme || 'ember');
    nativeLog('interface started, screen ' + window.innerWidth + 'x' + window.innerHeight + ' @' + window.devicePixelRatio);
    fit();
    window.addEventListener('resize', fit);
    tickClock();
    setInterval(tickClock, 15000);

    // Come back to where you were (the interface is rebuilt after background music).
    const nav = Store.get('nav', null);
    if (nav && Date.now() - nav.at < 30 * 60000 && nav.route) {
      route = nav.route; stack = nav.stack || []; homeIdx = nav.homeIdx || 0;
    }
    Bridge.on('server', s => Lib.addServer(s));
    try { appInfo = (await Bridge.call('info')) || {}; } catch (e) { appInfo = {}; }
    try { const st = await Bridge.call('state'); if (st) { P = st; lastTrackUrl = P.track ? P.track.url : null; } } catch (e) { /* ignore */ }
    if (route.name === 'now' && !P.track) { route = { name: 'home' }; stack = []; }
    // A fresh start (nothing playing) shows the welcome animation and opens on Home.
    // Coming back from background music skips it and returns to where you were.
    const freshStart = !P.track || P.state === 'stopped';
    // The app reloads the screen by itself if the browser engine crashed (for example out of
    // memory). Then go back to where you were, without the welcome animation.
    const recovered = /[?&]recovered=1/.test(location.search);
    if (freshStart && !recovered) { route = { name: 'home' }; stack = []; }
    render({});
    if (freshStart && !recovered && prefs.intro) Intro.play(); // the NAS connects in the background meanwhile
    if (recovered) {
      nativeLog('interface reloaded after a crash, back on ' + route.name);
      setTimeout(() => toast('WMC SX ran low on memory and reloaded this screen.', 5000), 600);
    }

    const saved = Lib.savedServer;
    if (saved && saved.location) {
      Bridge.call('connect', { location: saved.location }).catch(() => {});
    }
    try {
      const known = await Bridge.call('servers');
      (known || []).forEach(s => Lib.addServer(s));
    } catch (e) { /* ignore */ }
    Bridge.call('discover').catch(() => {});
    setTimeout(() => {
      // The saved NAS didn't answer; fall back to the first one that did.
      if (!Lib.server && Lib.servers.size) Lib.select(Lib.servers.values().next().value, true);
    }, 7000);
    requestAnimationFrame(pollPads);
  }
  start();
})();
