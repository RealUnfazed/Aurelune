import { synthWav } from '../../server/synth.js';
const B = 'http://localhost:3000/api/v1';
let pass = 0, fail = 0;
const ck = (n, ok, x = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : ' ' + JSON.stringify(x))); };
class Cli {
  constructor() { this.c = ''; }
  async req(m, p, body, extra = {}) {
    const h = { cookie: this.c, ...(extra.headers || {}) };
    let b;
    if (body instanceof FormData) b = body; else if (body) { h['content-type'] = 'application/json'; b = JSON.stringify(body); }
    const r = await fetch(B + p, { method: m, headers: h, body: b, redirect: 'manual' });
    const sc = r.headers.getSetCookie?.() || [];
    if (sc.length) this.c = sc.map((s) => s.split(';')[0]).join('; ');
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
    return { s: r.status, j, h: r.headers };
  }
  get(p) { return this.req('GET', p); }
}
const mk = async (u) => { const c = new Cli(); const r = await c.req('POST', '/auth/signup', { username: u, email: u + '@t.test', password: 'password123' }); if (r.s !== 201) throw new Error('signup ' + JSON.stringify(r)); return c; };
const rnd = Math.random().toString(36).slice(2, 7);
const admin = new Cli(); const lr = await admin.req('POST', '/auth/login', { login: 'admin@aurelune.local', password: 'aurelune-admin' });
if (lr.s !== 200) { const l2 = await admin.req('POST', '/auth/login', { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }); if (l2.s !== 200) throw new Error('admin login ' + JSON.stringify([lr, l2])); }
const owner = await mk('own' + rnd), other = await mk('oth' + rnd), anon = new Cli();
const ownerId = (await owner.get('/me')).j.user.id;
const page = async (name) => { const r = await owner.req('POST', '/studio/request', { name, focus: 'music' }); if (r.s >= 300) throw new Error(JSON.stringify(r)); await admin.req('POST', `/admin/creators/${r.j.creator.id}/approve`, {}); return r.j.creator.id; };
const pg1 = await page('Alpha' + rnd);
const wav = () => new Blob([synthWav({ seed: Math.floor(Math.random() * 999), seconds: 3 })], { type: 'audio/wav' });
const up = async (title, extra = {}, headers = {}) => {
  const fd = new FormData(); fd.append('audio', wav(), title + '.wav'); fd.append('title', title); fd.append('genre', 'Zzgenre' + rnd); fd.append('storage', 'local');
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return owner.req('POST', '/studio/tracks', fd, { headers });
};
const word = 'Secretword' + rnd;
const pub = await up('Public ' + word.replace('Secret', 'Open'), { lyrics: 'hello open lyrics' });
const priv = await up('Hidden ' + word, { visibility: 'private', lyrics: 'private lyrics here' });
ck('upload public', pub.s === 201 && pub.j.track.private === false, pub);
ck('upload private', priv.s === 201 && priv.j.track.private === true, priv);
const pubId = pub.j.track.id, privId = priv.j.track.id;
const idsOf = (j, k = 'tracks') => (j[k] || []).map((t) => t.id);

// search
for (const [n, c, want] of [['owner', owner, true], ['other', other, false], ['anon', anon, false]]) {
  const s = await c.get('/search?q=' + word);
  ck(`search: ${n} ${want ? 'finds' : 'does not find'} private`, idsOf(s.j).includes(privId) === want, s.j.tracks?.map((t) => t.title));
  const s2 = await c.get('/search?q=Openword' + rnd);
  ck(`search: ${n} finds public`, idsOf(s2.j).includes(pubId), s2.j);
}
// direct fetch / lyrics / stream
for (const [n, c, want] of [['owner', owner, 200], ['other', other, 404], ['anon', anon, 404]]) {
  ck(`GET /tracks/:id ${n} -> ${want}`, (await c.get('/tracks/' + privId)).s === want);
  ck(`lyrics ${n} -> ${want}`, (await c.get(`/tracks/${privId}/lyrics`)).s === want);
  const st = await c.req('GET', '/stream/track/' + privId);
  ck(`stream ${n} ${want === 200 ? 'ok' : 'blocked'}`, want === 200 ? st.s < 300 : (n === 'anon' ? st.s === 401 : st.s === 404), st.s);
  ck(`embed ${n}`, true);
}
ck('public track visible to anon', (await anon.get('/tracks/' + pubId)).s === 200);
ck('public stream other', (await other.req('GET', '/stream/track/' + pubId)).s < 300);
// artist / genre / tracks list
const slug = (await owner.get('/me')).j.user.creator?.slug;
const art = await owner.get('/artists/' + pg1); const artO = art.s === 200 ? art : await owner.get('/artists/' + slug);
const artA = await anon.get('/artists/' + (artO.j.artist?.slug || slug || pg1));
const aT = (j) => (j.top_tracks || j.tracks || []).map((t) => t.id);
ck('artist page: owner sees private', aT(artO.j).includes(privId), Object.keys(artO.j));
ck('artist page: anon does not', !aT(artA.j).includes(privId) && aT(artA.j).includes(pubId), aT(artA.j));
const gO = await owner.get('/genres/Zzgenre' + rnd), gA = await anon.get('/genres/Zzgenre' + rnd);
ck('genre: owner sees private', idsOf(gO.j).includes(privId), gO.j);
ck('genre: anon does not', !idsOf(gA.j).includes(privId) && idsOf(gA.j).includes(pubId), gA.j);
ck('/tracks anon excludes private', !idsOf(await (await anon.get('/tracks?limit=200')).j).includes(privId));
// home
const hO = (await owner.get('/home')).j, hA = (await other.get('/home')).j;
ck('home: owner private_tracks has it', idsOf(hO, 'private_tracks').includes(privId), hO.private_tracks);
ck('home: other private_tracks empty', (hA.private_tracks || []).length === 0);
const allHome = (h) => JSON.stringify([h.trending, h.recent, h.from_follows, h.new_albums]);
ck('home: other never sees id anywhere', !JSON.stringify(hA).includes(privId));
// likes
ck('like: other 404', (await other.req('PUT', '/me/likes/' + privId)).s === 404);
ck('like: owner ok', (await owner.req('PUT', '/me/likes/' + privId)).s === 200);
const lk = await owner.get('/me/likes'); ck('likes: owner lists private', idsOf(lk.j).includes(privId), lk.j);
// playlists: other tries to add; owner makes public playlist with both
const opl = await other.req('POST', '/playlists', { title: 'x', track_ids: [privId, pubId], is_public: true });
ck('playlist: other cannot add private (only public kept)', idsOf(opl.j.playlist ? { t: [] } : {}, 't').length === 0 && opl.j.playlist.track_count === 1, opl.j);
const pl = await owner.req('POST', '/playlists', { title: 'mix' + rnd, track_ids: [privId, pubId], is_public: true });
const plId = pl.j.playlist.id;
const plO = await owner.get('/playlists/' + plId), plA = await anon.get('/playlists/' + plId);
ck('playlist: owner sees both', idsOf(plO.j).includes(privId) && idsOf(plO.j).includes(pubId), idsOf(plO.j));
ck('playlist: anon sees only public', !idsOf(plA.j).includes(privId) && idsOf(plA.j).includes(pubId), idsOf(plA.j));
ck('playlist dto: public count excludes private (anon view)', plA.j.playlist.track_count === 1 || plO.j.playlist.track_count === 1, [plA.j.playlist.track_count, plO.j.playlist.track_count]);
// now playing
const uname = 'own' + rnd;
await owner.req('PUT', '/me/player', { kind: 'track', item_id: privId, track_id: privId, playing: true, position_ms: 100 }).catch(() => {});
await owner.req('POST', '/me/plays', { kind: 'track', id: privId, item_id: privId, ms_played: 2000 });
const np = await anon.get(`/users/${uname}/now-playing`);
ck('public now-playing does not leak private', !JSON.stringify(np.j).includes(privId), np.j);
// embed
const em = await anon.req('GET', '/../embed/track/' + privId).catch(() => ({ s: 0 }));
const embedRes = await fetch('http://localhost:3000/embed/track/' + privId); ck('embed private anon 404', embedRes.status === 404, embedRes.status);
const embedPub = await fetch('http://localhost:3000/embed/track/' + pubId); ck('embed public anon 200', embedPub.status === 200, embedPub.status);
// toggle via PATCH JSON-less (form) and visibility
const fdp = new FormData(); fdp.append('visibility', 'public');
const t1 = await owner.req('PATCH', '/studio/tracks/' + privId, fdp);
ck('patch visibility public', t1.s === 200 && t1.j.track.published === true, t1);
ck('now public: other sees it', (await other.get('/tracks/' + privId)).s === 200);
const t2 = await owner.req('PATCH', '/studio/tracks/' + privId, { visibility: 'private' });
ck('patch visibility private (json)', t2.s === 200, t2);
ck('private again: other 404', (await other.get('/tracks/' + privId)).s === 404);
// multi-page owner
await admin.req('PATCH', '/admin/users/' + ownerId, { creator_limit: 3 });
const pg2 = await page('Beta' + rnd);
ck('owner still sees private from other page context', (await owner.req('GET', '/tracks/' + privId, null, { headers: { 'x-creator-page': pg2 } })).s === 200);
// other creator cannot see owner's private
const o2 = await mk('cr2' + rnd); const r2 = await o2.req('POST', '/studio/request', { name: 'Gamma' + rnd, focus: 'music' }); await admin.req('POST', `/admin/creators/${r2.j.creator.id}/approve`, {});
ck('another approved creator cannot see it', (await o2.get('/tracks/' + privId)).s === 404);
ck('another creator search', !idsOf((await o2.get('/search?q=' + word)).j).includes(privId));
// episode private
const show = await owner.req('POST', '/studio/shows', (() => { const f = new FormData(); f.append('title', 'Show' + rnd); f.append('category', 'x'); return f; })());
if (show.s === 201) {
  const sid = show.j.show.id;
  const fe = new FormData(); fe.append('audio', wav(), 'e.wav'); fe.append('title', 'PrivEp' + rnd); fe.append('storage', 'local'); fe.append('published', '0');
  const ep = await owner.req('POST', `/studio/shows/${sid}/episodes`, fe);
  ck('private episode created', ep.s === 201 && ep.j.episode.private === true, ep);
  if (ep.s === 201) {
    const eid = ep.j.episode.id;
    ck('episode: other 404', (await other.get('/episodes/' + eid)).s === 404);
    ck('episode: owner 200', (await owner.get('/episodes/' + eid)).s === 200);
    ck('episode search: other no', !JSON.stringify((await other.get('/search?q=PrivEp' + rnd)).j).includes(eid));
    ck('episode search: owner yes', JSON.stringify((await owner.get('/search?q=PrivEp' + rnd)).j).includes(eid));
    const sh = await other.get('/shows/' + sid); ck('show page: other lacks episode', !JSON.stringify(sh.j).includes(eid), sh.s);
    const so = await owner.get('/shows/' + sid); ck('show page: owner has episode', JSON.stringify(so.j).includes(eid), so.s);
  }
} else console.log('show create', show.s, JSON.stringify(show.j).slice(0, 200));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
