/* Stand-in for the native app, used only when index.html is opened in a normal browser.
   Lets the interface be tried without an Xbox: fake NAS, fake USB drive, simulated player. */
'use strict';
window.WmcMock = (function () {
  const emit = (ev, d) => setTimeout(() => window.WmcBridge.emit(ev, d), 0);
  const wait = (v, ms) => new Promise(r => setTimeout(() => r(v), ms || 60));

  const nodes = {};
  function add(parent, item) {
    nodes[item.id] = { item: item, children: [] };
    if (parent) nodes[parent].children.push(item);
    return item;
  }
  add(null, { id: '0', kind: 'container', title: 'Root' });
  add('0', { id: 'm', kind: 'container', title: 'Music' });
  add('0', { id: 'v', kind: 'container', title: 'Video' });
  add('0', { id: 'p', kind: 'container', title: 'Photo' });
  add('m', { id: 'm-all', kind: 'container', title: 'All Music' });
  add('m', { id: 'm-f', kind: 'container', title: 'Folder' });
  add('v', { id: 'v-f', kind: 'container', title: 'Folder' });
  add('p', { id: 'p-f', kind: 'container', title: 'Folder' });

  const artists = ['Glass Harbor', 'The Aqua Lines', 'Northern Bloom', 'Velvet Static', 'Paper Comets', 'Sundial Club', 'Low Orbit', 'Harbor Lights'];
  const words = ['Blue', 'Morning', 'Signal', 'River', 'Neon', 'Echo', 'Summer', 'Glass', 'Static', 'Horizon', 'Lantern', 'Drift', 'Satellite', 'Cloud', 'Ocean'];
  const genres = ['Pop', 'Rock', 'Electronic', 'Indie', 'Ambient'];
  let n = 0;
  artists.forEach((a, ai) => {
    const af = add('m-f', { id: 'a' + ai, kind: 'container', title: a, childCount: 3 });
    for (let b = 0; b < 3; b++) {
      const album = words[(ai * 3 + b) % words.length] + ' ' + words[(ai + b * 5 + 2) % words.length];
      const alb = add(af.id, { id: 'a' + ai + 'b' + b, kind: 'container', title: album, childCount: 10 });
      for (let t = 0; t < 10; t++) {
        n++;
        add(alb.id, {
          id: 't' + n, kind: 'audio', title: words[(n * 7) % words.length] + ' ' + words[(n * 3 + 1) % words.length],
          artist: a, album: album, genre: genres[(ai + b) % genres.length], track: t + 1, duration: 150 + (n * 37) % 160,
          url: 'http://nas/track' + n + '.mp3', art: ''
        });
      }
    }
  });
  for (let i = 0; i < 18; i++) {
    add('v-f', { id: 'vid' + i, kind: 'video', title: 'Home video ' + (i + 1), duration: 1200 + i * 300, url: 'http://nas/video' + i + '.mp4', art: '' });
  }
  // A very big folder, to check folders over 5,000 items load completely.
  const big = add('p-f', { id: 'pbig', kind: 'container', title: 'Phone backup', childCount: 30214 });
  for (let i = 0; i < 30214; i++) add(big.id, { id: 'pb' + i, kind: 'image', title: 'IMG_' + (10000 + i), url: '', thumb: '' });
  for (let f = 0; f < 3; f++) {
    const pf = add('p-f', { id: 'pf' + f, kind: 'container', title: ['Vacation', 'Family', 'Screenshots'][f], childCount: 12 });
    for (let i = 0; i < 12; i++) add(pf.id, { id: 'ph' + f + '-' + i, kind: 'image', title: 'IMG_' + (1000 + f * 100 + i), url: '', thumb: '' });
  }

  const server = { id: 'uuid:homenas', name: 'Home NAS', location: 'http://192.168.1.20:50001/desc/device.xml', host: '192.168.1.20', model: 'NAS', manufacturer: 'Synology' };

  // ---------- Simulated player
  const player = { queue: [], index: -1, pos: 0, state: 'stopped', shuffle: false, repeat: 'off' };
  function state() {
    const t = player.queue[player.index];
    return {
      state: player.state, position: player.pos, duration: t ? t.duration || 200 : 0, shuffle: player.shuffle, repeat: player.repeat,
      count: player.queue.length, index: player.index, track: t || null, upNext: player.queue.slice(player.index + 1, player.index + 9)
    };
  }
  setInterval(() => {
    if (player.state !== 'playing') return;
    player.pos += 1;
    const t = player.queue[player.index];
    if (t && player.pos >= (t.duration || 200)) { player.index = (player.index + 1) % player.queue.length; player.pos = 0; }
    emit('player', state());
  }, 1000);

  function call(cmd, a) {
    switch (cmd) {
      case 'info': return wait({ version: '1.0.0', device: 'Browser preview' });
      case 'servers': return wait([]);
      case 'discover': setTimeout(() => emit('server', server), 900); return wait(null);
      case 'probe': setTimeout(() => emit('server', server), 400); return wait(null);
      case 'connect': setTimeout(() => emit('server', server), 300); return wait([server]);
      case 'browse': {
        const node = nodes[a.id];
        if (!node) return Promise.reject(new Error('Not found'));
        const items = node.children.slice(a.start, a.start + a.count);
        return wait({ items: items, total: node.children.length, returned: items.length }, 40);
      }
      case 'usbList':
        if (!a.path) return wait([{ kind: 'container', id: 'E:\\', title: 'IPOD', drive: true }]);
        return wait([{ kind: 'container', id: 'E:\\Music', title: 'Music' }].concat(
          [1, 2, 3, 4, 5].map(i => ({ kind: 'audio', id: 'E:\\song' + i + '.mp3', url: 'usb:E:\\song' + i + '.mp3', title: 'USB song ' + i, artist: 'Paper Comets', album: 'On the Go', duration: 200, usb: true, art: '' }))));
      case 'usbScan':
        return wait([1, 2, 3, 4, 5, 6, 7, 8].map(i => ({ kind: 'audio', id: 'E:\\s' + i, url: 'usb:E:\\s' + i + '.mp3', title: 'iPod song ' + i, artist: 'Low Orbit', album: 'Pocket', track: i, duration: 180, usb: true })), 800);
      case 'play':
        player.queue = a.tracks; player.index = a.start || 0; player.pos = 0; player.state = 'playing'; player.shuffle = !!a.shuffle;
        emit('player', state());
        return wait(state());
      case 'control':
        if (a.action === 'toggle') player.state = player.state === 'playing' ? 'paused' : 'playing';
        else if (a.action === 'next') { player.index = Math.min(player.queue.length - 1, player.index + 1); player.pos = 0; }
        else if (a.action === 'prev') { if (player.pos > 4) player.pos = 0; else player.index = Math.max(0, player.index - 1); }
        else if (a.action === 'skip') player.pos = Math.max(0, player.pos + a.value);
        else if (a.action === 'shuffle') player.shuffle = a.value > 0;
        else if (a.action === 'repeat') player.repeat = a.value >= 2 ? 'one' : a.value >= 1 ? 'all' : 'off';
        emit('player', state());
        return wait(state());
      case 'state': return wait(state());
      case 'playVideo':
        setTimeout(() => window.WmcBridge.emit('toast', 'Browser preview: the Xbox would play “' + a.title + '” full screen now.'), 50);
        setTimeout(() => emit('videoClosed', { key: a.key, position: 600, duration: 2400, ended: false }), 1500);
        return wait(null);
      case 'readLog':
        return wait(Array.from({ length: 120 }, (_, i) => '21:' + String(10 + (i % 50)).padStart(2, '0') + ':00 browser preview ' + (a && a.previous ? 'last time\u2019s' : '') + ' log line ' + (i + 1)).join('\n'));
      case 'saveFile': try { localStorage.setItem('mockfile.' + a.name, a.text); } catch (e) { /* ignore */ } return wait(null);
      case 'loadFile': try { return wait(localStorage.getItem('mockfile.' + a.name)); } catch (e) { return wait(null); }
    }
    return Promise.reject(new Error('Mock: unknown command ' + cmd));
  }
  return { call: call };
})();
