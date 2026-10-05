const B = 'http://localhost:3000'; const A = B + '/api/v1'; let pass = 0, fail = 0;
const ck = (n, ok, x = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : ' ' + JSON.stringify(x))); };
class Cli { constructor() { this.c = ''; } async req(m, p, body, extra = {}) { const h = { cookie: this.c, ...(extra.headers || {}) }; let b; if (body instanceof FormData) b = body; else if (body) { h['content-type'] = 'application/json'; b = JSON.stringify(body); } const r = await fetch(A + p, { method: m, headers: h, body: b, redirect: 'manual' }); const sc = r.headers.getSetCookie?.() || []; if (sc.length) this.c = sc.map((s) => s.split(';')[0]).join('; '); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; } get(p, h) { return this.req('GET', p, null, { headers: h }); } }

import { synthWav } from '../../server/synth.js';
import mongoose from 'mongoose';
const rid = Math.random().toString(36).slice(2, 7);
const mk = async (u) => { const c = new Cli(); const r = await c.req('POST', '/auth/signup', { username: u, email: u + '@t.test', password: 'password123' }); if (r.s !== 201) throw new Error(JSON.stringify(r)); return c; };
const admin = new Cli(); let l = await admin.req('POST', '/auth/login', { login: 'admin@aurelune.local', password: 'aurelune-admin' });
const owner = await mk('so' + rid), other = await mk('sx' + rid), anon = new Cli();
const page = async (c, name) => { const r = await c.req('POST', '/studio/request', { name, focus: 'both' }); await admin.req('POST', `/admin/creators/${r.j.creator.id}/approve`, {}); return r.j.creator; };
const P = await page(owner, 'Showband' + rid);
const wav = () => new Blob([synthWav({ seed: 5, seconds: 3 })], { type: 'audio/wav' });
const mkShow = async (title, extra = {}) => { const fd = new FormData(); fd.append('title', title); for (const [k, v] of Object.entries(extra)) fd.append(k, v); return owner.req('POST', '/studio/shows', fd); };
const mkEp = async (showId, title, extra = {}) => { const fd = new FormData(); fd.append('audio', wav(), 'a.wav'); fd.append('title', title); fd.append('storage', 'local'); for (const [k, v] of Object.entries(extra)) fd.append(k, v); return owner.req('POST', `/studio/shows/${showId}/episodes`, fd); };
const T = 'Emptycast' + rid;
const sees = async (c, id) => ({
  home: (await c.get('/home')).j.shows?.some((s) => s.id === id),
  search: (await c.get('/search?q=' + T)).j.shows?.some((s) => s.id === id),
  artist: (await c.get('/artists/' + P.id)).j.shows?.some((s) => s.id === id),
});
// 1. a brand-new, empty public show
const s1 = await mkShow(T); ck('show created, public by default', s1.s === 201 && s1.j.show.private === false, s1.j);
const sid = s1.j.show.id;
let v = await sees(other, sid); ck('empty show NOT on another listener\'s home / search / artist page', !v.home && !v.search && !v.artist, v);
v = await sees(anon, sid); ck('...nor for anonymous visitors', !v.home && !v.search && !v.artist, v);
v = await sees(owner, sid); ck('owner still sees their own empty show everywhere', v.home && v.search && v.artist, v);
v = await sees(admin, sid); ck('admin sees it', v.home && v.search && v.artist, v);
const direct = await other.get('/shows/' + sid); ck('direct link to an empty public show still opens', direct.s === 200 && direct.j.show.episode_count === 0, direct.s);
const studioShow = (await owner.get('/studio')).j.shows.find((s) => s.id === sid); ck('studio says it has no public episode yet', studioShow.public_episode_count === 0 && studioShow.episode_count === 0, studioShow);

// 2. a private episode only: still invisible to others, owner count includes it
const ep0 = await mkEp(sid, 'PrivEp' + rid, { published: 'false' }); ck('private episode uploaded', ep0.s === 201 && ep0.j.episode.private === true, ep0.j);
v = await sees(other, sid); ck('only a private episode: show still hidden from others', !v.home && !v.search && !v.artist, v);
const st2 = (await owner.get('/studio')).j.shows.find((s) => s.id === sid); ck('owner count includes the private episode, public count is 0', st2.episode_count === 1 && st2.public_episode_count === 0, st2);

// 3. a public episode lists it
const ep1 = await mkEp(sid, 'PubEp' + rid); ck('public episode uploaded', ep1.s === 201, ep1.j);
const eid = ep1.j.episode.id;
v = await sees(other, sid); ck('with a public episode the show is listed for everyone', v.home && v.search && v.artist, v);
v = await sees(anon, sid); ck('...and for anonymous visitors', v.home && v.search && v.artist, v);
const pg = (await other.get('/shows/' + sid)).j; ck('listener sees only the public episode', pg.episodes.length === 1 && pg.show.episode_count === 1, pg.episodes.map((e) => e.title));

// 4. make the whole show private
const pr = await owner.req('PATCH', '/studio/shows/' + sid, { visibility: 'private' }); ck('owner makes the show private', pr.s === 200 && pr.j.show.private === true, pr.j);
v = await sees(other, sid); ck('private show gone from home / search / artist for others', !v.home && !v.search && !v.artist, v);
v = await sees(anon, sid); ck('...and for anonymous', !v.home && !v.search && !v.artist, v);
ck('direct link 404 for another user', (await other.get('/shows/' + sid)).s === 404);
ck('direct link 404 for anonymous', (await anon.get('/shows/' + sid)).s === 404);
ck('its episode cannot be streamed by others', (await other.req('GET', '/stream/episode/' + eid, undefined, { raw: true })).s === 404);
ck('...nor opened as an embed', (await fetch(B + '/embed/episode/' + eid)).status === 404);
const eps = (await other.get('/home')).j.new_episodes ?? (await other.get('/home')).j.episodes ?? []; ck('its episodes are not in other people\'s home feed', !JSON.stringify((await other.get('/home')).j).includes(eid));
ck('not found when searching for the episode', !JSON.stringify((await other.get('/search?q=PubEp' + rid)).j).includes(eid));
ck('cannot follow a private show', (await other.req('PUT', '/me/following/shows/' + sid, {})).s === 404);
v = await sees(owner, sid); ck('owner still sees it', v.home && v.search && v.artist, v);
const own = (await owner.get('/shows/' + sid)); ck('owner opens it, with the lock flag, and its episodes (incl. private) are marked private', own.s === 200 && own.j.show.private === true && own.j.episodes.length === 2 && own.j.episodes.every((e) => e.private), own.j.episodes?.map((e) => e.private));
ck('owner can stream the episode', (await owner.req('GET', '/stream/episode/' + eid, undefined, { raw: true })).s === 200);
v = await sees(admin, sid); ck('admin sees it', v.home && v.search && v.artist, v);
ck('admin opens it', (await admin.get('/shows/' + sid)).s === 200);

// 5. back to public
await owner.req('PATCH', '/studio/shows/' + sid, { visibility: 'public' });
v = await sees(other, sid); ck('public again: listed again', v.home && v.search && v.artist, v);
ck('other can stream the episode again', (await other.req('GET', '/stream/episode/' + eid, undefined, { raw: true })).s === 200);
ck('other can follow it', (await other.req('PUT', '/me/following/shows/' + sid, {})).s < 300);

// 6. legacy documents without the field behave as public
await mongoose.connect('mongodb://127.0.0.1:27017/aurelune');
await mongoose.connection.collection('shows').updateOne({ _id: new mongoose.Types.ObjectId(sid) }, { $unset: { published: 1 } });
v = await sees(other, sid); ck('legacy show (no published field) counts as public', v.home && v.search && v.artist, v);
ck('legacy show opens and its episode streams', (await other.get('/shows/' + sid)).s === 200 && (await other.req('GET', '/stream/episode/' + eid, undefined, { raw: true })).s === 200);
await owner.req('PATCH', '/studio/shows/' + sid, { visibility: 'private' });
ck('and can still be made private afterwards', !(await sees(other, sid)).home);
await mongoose.disconnect();
console.log(pass + ' passed, ' + fail + ' failed');
