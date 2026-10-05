const B = 'http://localhost:3000'; const A = B + '/api/v1'; let pass = 0, fail = 0;
const ck = (n, ok, x = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : ' ' + JSON.stringify(x))); };
class Cli { constructor() { this.c = ''; } async req(m, p, body, extra = {}) { const h = { cookie: this.c, ...(extra.headers || {}) }; let b; if (body instanceof FormData) b = body; else if (body) { h['content-type'] = 'application/json'; b = JSON.stringify(body); } const r = await fetch(A + p, { method: m, headers: h, body: b, redirect: 'manual' }); const sc = r.headers.getSetCookie?.() || []; if (sc.length) this.c = sc.map((s) => s.split(';')[0]).join('; '); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; } get(p, h) { return this.req('GET', p, null, { headers: h }); } }
import { synthWav } from '../../server/synth.js';
const rid = Math.random().toString(36).slice(2, 7);
const mk = async (u) => { const c = new Cli(); const r = await c.req('POST', '/auth/signup', { username: u, email: u + '@t.test', password: 'password123' }); if (r.s !== 201) throw new Error(JSON.stringify(r)); return c; };
const admin = new Cli(); let l = await admin.req('POST', '/auth/login', { login: 'admin@aurelune.local', password: 'aurelune-admin' }); if (l.s !== 200) l = await admin.req('POST', '/auth/login', { login: 'admin@aurelune.local', password: 'adminpass123' });
const u1 = await mk('c1' + rid), u2 = await mk('c2' + rid), u3 = await mk('c3' + rid), anon = new Cli();
const id1 = (await u1.get('/me')).j.user.id; await admin.req('PATCH', '/admin/users/' + id1, { creator_limit: 3 });
const page = async (c, name) => { const r = await c.req('POST', '/studio/request', { name, focus: 'both' }); await admin.req('POST', `/admin/creators/${r.j.creator.id}/approve`, {}); return r.j.creator; };
const A1 = await page(u1, 'Alphaband' + rid), A2 = await page(u1, 'Alphaside' + rid), Bp = await page(u2, 'Bravoband' + rid), Cp = await page(u3, 'Charlieband' + rid);
await admin.req('PATCH', '/admin/users/' + (await u3.get('/me')).j.user.id, { creator_limit: 3 });
const pending = await (async () => { const r = await u3.req('POST', '/studio/request', { name: 'Notyet' + rid, focus: 'both' }); return r.j.creator; })(); // never approved
const wav = () => new Blob([synthWav({ seed: 3, seconds: 3 })], { type: 'audio/wav' });
const H = (p) => ({ 'x-creator-page': p.id });
const upTrack = (title, collabs, extra = {}) => { const fd = new FormData(); fd.append('audio', wav(), 'a.wav'); fd.append('title', title); fd.append('storage', 'local'); if (collabs !== undefined) fd.append('collaborators', typeof collabs === 'string' ? collabs : JSON.stringify(collabs)); for (const [k, v] of Object.entries(extra)) fd.append(k, v); return u1.req('POST', '/studio/tracks', fd, { headers: H(A1) }); };

// -- validation
ck('unknown / unapproved / self pages are refused', (await upTrack('bad1' + rid, [pending.id])).s === 400 && (await upTrack('bad2' + rid, ['0123456789abcdef01234567'])).s === 400);
const self = await upTrack('self' + rid, [A1.id]); ck('crediting your own page as a collaborator is ignored', self.s === 201 && self.j.track.collaborators.length === 0, self.j);
ck('too many collaborators refused', (await upTrack('many' + rid, Array(9).fill(0).map((_, i) => ('0123456789abcdef0123456' + i)))).s === 400);

// -- invite flow
const t = await upTrack('Duet' + rid, [Bp.id, A2.id]); ck('track with two collaborators created', t.s === 201, t);
const tid = t.j.track.id;
const dtoOf = async (c, as) => (await c.get('/tracks/' + tid)).j.track;
let d = await dtoOf(u1);
ck('owner sees both: own page accepted at once, other page pending', d.collaborators.find((c) => c.id === A2.id)?.status === 'accepted' && d.collaborators.find((c) => c.id === Bp.id)?.status === 'pending', d.collaborators);
d = await dtoOf(anon); ck('public sees only the accepted one', d.collaborators.length === 1 && d.collaborators[0].id === A2.id, d.collaborators);
d = await dtoOf(u2); ck('invited owner sees the invitation', d.collaborators.some((c) => c.id === Bp.id && c.status === 'pending'), d.collaborators);
d = await dtoOf(u3); ck('a stranger does not see the pending invite', !d.collaborators.some((c) => c.id === Bp.id), d.collaborators);
const artistB = async (c) => { const r = await c.get('/artists/' + Bp.id); if (r.s !== 200) console.log('ARTIST ERR', r); return r.j; };
ck('pending: track NOT on invited page yet', !(await artistB(anon)).top_tracks.some((x) => x.id === tid));
ck('pending: not found by searching the invited page', !(await anon.get('/search?q=Bravoband' + rid)).j.tracks.some((x) => x.id === tid));
const inbox = (await u2.get('/studio/collabs')).j; ck('invitee inbox lists it as pending', inbox.pending === 1 && inbox.collabs[0].id === tid && inbox.collabs[0].status === 'pending' && inbox.collabs[0].by.id === A1.id && inbox.collabs[0].page.id === Bp.id, inbox);
ck('dashboard badge counts invites', (await u2.get('/studio')).j.pending_invites === 1);
ck('stranger cannot answer it', (await u3.req('POST', `/studio/collabs/track/${tid}/accept`, {})).s === 404);
d = await dtoOf(anon); ck('uploader accept attempt did not change anything for B', !d.collaborators.some((c) => c.id === Bp.id), d.collaborators);
const acc = await u2.req('POST', `/studio/collabs/track/${tid}/accept`, {}); ck('invitee accepts', acc.s === 200 && acc.j.status === 'accepted', acc);
d = await dtoOf(anon); ck('accepted: public sees both collaborators', d.collaborators.length === 2, d.collaborators);
ck('accepted: on the collaborator\'s artist page', (await artistB(anon)).top_tracks.some((x) => x.id === tid));
ck('accepted: track_count includes it', (await artistB(anon)).track_count >= 1);
ck('accepted: found by searching the collaborator', (await anon.get('/search?q=Bravoband' + rid)).j.tracks.some((x) => x.id === tid));
ck('still on the primary page', (await anon.get('/artists/' + A1.id)).j.top_tracks.some((x) => x.id === tid));
ck('invitee inbox now shows accepted', (await u2.get('/studio/collabs')).j.collabs[0].status === 'accepted' && (await u2.get('/studio')).j.pending_invites === 0);

// follower of the collaborator gets it on Home
await u3.req('PUT', '/me/following/artists/' + Bp.id);
ck('followers of a collaborator see it in "from your follows"', (await u3.get('/home')).j.from_follows.some((x) => x.id === tid));

// -- private track: accepted collaborator keeps access, strangers don't
const priv = await u1.req('PATCH', '/studio/tracks/' + tid, (() => { const f = new FormData(); f.append('visibility', 'private'); return f; })(), { headers: H(A1) });
ck('track made private', priv.s === 200 && priv.j.track.private === true, priv);
ck('private: accepted collaborator still sees it', (await u2.get('/tracks/' + tid)).s === 200);
ck('private: collaborator can stream it', (await u2.req('GET', '/stream/track/' + tid)).s < 300);
ck('private: stranger gets 404', (await u3.get('/tracks/' + tid)).s === 404 && (await u3.req('GET', '/stream/track/' + tid)).s === 404);
ck('private: not on the collaborator\'s PUBLIC page listing', !(await artistB(anon)).top_tracks.some((x) => x.id === tid));
await u1.req('PATCH', '/studio/tracks/' + tid, (() => { const f = new FormData(); f.append('visibility', 'public'); return f; })(), { headers: H(A1) });

// -- private collaborator page is hidden in the credits
const fdp = new FormData(); fdp.append('visibility', 'private');
await u2.req('PATCH', '/studio/profile', fdp, { headers: H(Bp) });
d = await dtoOf(anon); ck('collaborator on a private page is not credited publicly', !d.collaborators.some((c) => c.id === Bp.id), d.collaborators);
ck('…and the page itself is 404', (await anon.get('/artists/' + Bp.id)).s === 404);
d = await dtoOf(u2); ck('…but its owner still sees the credit', d.collaborators.some((c) => c.id === Bp.id));
const fdq = new FormData(); fdq.append('visibility', 'public'); await u2.req('PATCH', '/studio/profile', fdq, { headers: H(Bp) });

// -- picker search
const srch = (await u1.get('/studio/artists?q=Bravo', H(A1))).j.artists; ck('picker finds other pages by name', srch.some((a) => a.id === Bp.id) && srch.every((a) => a.id !== A1.id), srch.map((a) => a.name));
const own = (await u1.get('/studio/artists?q=Alphaside' + rid, H(A1))).j.artists; ck('picker flags the account\'s own other page', own[0]?.id === A2.id && own[0].mine === true, own);
ck('picker never offers unapproved pages', !(await u1.get('/studio/artists?q=Notyet' + rid, H(A1))).j.artists.length);
await u3.req('PATCH', '/studio/profile', (() => { const f = new FormData(); f.append('visibility', 'private'); return f; })(), { headers: H(Cp) });
ck('picker never offers someone else\'s private page', !(await u1.get('/studio/artists?q=Charlie' + rid, H(A1))).j.artists.length);
ck('inviting someone else\'s private page is refused', (await upTrack('priv-inv' + rid, [Cp.id])).s === 400);
await u3.req('PATCH', '/studio/profile', (() => { const f = new FormData(); f.append('visibility', 'public'); return f; })(), { headers: H(Cp) });

// -- edit: remove, re-add, leave
let e1 = await u1.req('PATCH', '/studio/tracks/' + tid, (() => { const f = new FormData(); f.append('collaborators', JSON.stringify([Bp.id])); return f; })(), { headers: H(A1) });
ck('edit keeps an accepted answer and drops the removed page', e1.s === 200 && e1.j.track.collaborators.length === 1 && e1.j.track.collaborators[0].status === 'accepted', e1.j);
e1 = await u1.req('PATCH', '/studio/tracks/' + tid, (() => { const f = new FormData(); f.append('collaborators', '[]'); return f; })(), { headers: H(A1) });
ck('empty list removes everyone', e1.j.track.collaborators.length === 0);
ck('removed: gone from the page again', !(await artistB(anon)).top_tracks.some((x) => x.id === tid));
await u1.req('PATCH', '/studio/tracks/' + tid, (() => { const f = new FormData(); f.append('collaborators', Bp.id); return f; })(), { headers: H(A1) }); // comma-string form
d = await dtoOf(u1); ck('re-adding starts over as pending (comma-separated form works)', d.collaborators[0]?.status === 'pending', d.collaborators);
await u2.req('POST', `/studio/collabs/track/${tid}/decline`, {});
d = await dtoOf(u1); ck('declined: removed', d.collaborators.length === 0, d.collaborators);
await u1.req('PATCH', '/studio/tracks/' + tid, (() => { const f = new FormData(); f.append('collaborators', Bp.id); return f; })(), { headers: H(A1) });
await u2.req('POST', `/studio/collabs/track/${tid}/accept`, {});
const leave = await u2.req('POST', `/studio/collabs/track/${tid}/decline`, {}); ck('a collaborator can leave later', leave.s === 200 && (await dtoOf(anon)).collaborators.length === 0, leave);

// -- episodes
const sh = await u1.req('POST', '/studio/shows', (() => { const f = new FormData(); f.append('title', 'Duocast' + rid); f.append('category', 'x'); return f; })(), { headers: H(A1) });
const fe = new FormData(); fe.append('audio', wav(), 'e.wav'); fe.append('title', 'Guestep' + rid); fe.append('storage', 'local'); fe.append('collaborators', JSON.stringify([Bp.id]));
const ep = await u1.req('POST', `/studio/shows/${sh.j.show.id}/episodes`, fe, { headers: H(A1) });
ck('episode created with a guest', ep.s === 201 && ep.j.episode.collaborators[0]?.status === 'pending', ep);
const eid = ep.j.episode.id;
ck('episode invitation appears in the inbox', (await u2.get('/studio/collabs')).j.collabs.some((c) => c.kind === 'episode' && c.id === eid && c.status === 'pending'));
ck('pending episode not featured yet', !(await artistB(anon)).featured_episodes.some((x) => x.id === eid));
await u2.req('POST', `/studio/collabs/episode/${eid}/accept`, {});
ck('accepted episode is featured on the guest\'s page', (await artistB(anon)).featured_episodes.some((x) => x.id === eid));
ck('accepted episode found when searching the guest', (await anon.get('/search?q=Bravoband' + rid)).j.episodes.some((x) => x.id === eid));
const pe = await u1.req('PATCH', '/studio/episodes/' + eid, { collaborators: [] }); ck('episode PATCH (JSON) can remove the guest', pe.s === 200 && pe.j.episode.collaborators.length === 0, pe);
ck('wrong kind -> 404', (await u2.req('POST', `/studio/collabs/podcast/${eid}/accept`, {})).s === 404);

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
