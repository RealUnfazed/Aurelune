import mongoose from 'mongoose';

const { Schema, model } = mongoose;
const ref = (to, extra = {}) => ({ type: Schema.Types.ObjectId, ref: to, ...extra });
const createdOnly = { timestamps: { createdAt: 'createdAt', updatedAt: false } };

export const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/aurelune';

export async function connectDb(uri = MONGODB_URI) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  await Promise.all(Object.values(mongoose.models).map((m) => m.init().catch(() => {})));
  return mongoose.connection;
}

/* ------------------------------ Accounts ------------------------------ */

export const User = model('User', new Schema({
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  displayName: { type: String, required: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['listener', 'admin'], default: 'listener' },
  bio: { type: String, default: '' },
  shareActivity: { type: Boolean, default: true }, // public now-playing + public profile stats
}, createdOnly));

export const Session = model('Session', new Schema({
  tokenHash: { type: String, required: true, unique: true },
  user: ref('User', { required: true, index: true }),
  expiresAt: { type: Date, required: true, index: { expires: 0 } }, // TTL: Mongo deletes expired sessions
  userAgent: String,
}, createdOnly));

export const ApiToken = model('ApiToken', new Schema({
  user: ref('User', { required: true, index: true }),
  name: { type: String, required: true },
  tokenHash: { type: String, required: true, unique: true },
  prefix: { type: String, required: true },
  scopes: [String],
  lastUsedAt: Date,
}, createdOnly));

/* ------------------------------ Creators & catalog ------------------------------ */

// A creator page: artists publish music, podcasters publish shows. One page per user.
export const Creator = model('Creator', new Schema({
  user: ref('User', { required: true, unique: true }),
  name: { type: String, required: true, trim: true },
  slug: { type: String, required: true, unique: true },
  bio: { type: String, default: '' },
  focus: { type: String, enum: ['music', 'podcasts', 'both'], default: 'music' },
  links: [{ _id: false, label: String, url: String }],
  image: String,
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'suspended'], default: 'pending', index: true },
  verified: { type: Boolean, default: false },
  reviewNote: String,
  requestedAt: { type: Date, default: Date.now },
  reviewedAt: Date,
}, createdOnly));

export const Album = model('Album', new Schema({
  artist: ref('Creator', { required: true, index: true }),
  title: { type: String, required: true },
  kind: { type: String, enum: ['album', 'single', 'ep'], default: 'album' },
  description: { type: String, default: '' },
  cover: String,
  releasedAt: { type: Date, default: Date.now, index: true },
  hidden: { type: Boolean, default: false }, // set by moderation
}, createdOnly));

export const Track = model('Track', new Schema({
  artist: ref('Creator', { required: true, index: true }),
  album: ref('Album', { default: null, index: true }),
  title: { type: String, required: true },
  credits: { type: String, default: '' },
  genre: { type: String, default: '', index: true },
  durationMs: { type: Number, default: 0 },
  audio: { type: String, required: true },
  mime: { type: String, default: 'audio/mpeg' },
  cover: String,
  lyrics: { type: String, default: '' }, // plain text or LRC — detected on read
  explicit: { type: Boolean, default: false },
  trackNo: { type: Number, default: 1 },
  plays: { type: Number, default: 0, index: true },
  published: { type: Boolean, default: true },
  hidden: { type: Boolean, default: false },
}, createdOnly));

export const Show = model('Show', new Schema({
  artist: ref('Creator', { required: true, index: true }),
  title: { type: String, required: true },
  description: { type: String, default: '' },
  category: { type: String, default: '' },
  language: { type: String, default: 'en' },
  explicit: { type: Boolean, default: false },
  cover: String,
  hidden: { type: Boolean, default: false },
}, createdOnly));

export const Episode = model('Episode', new Schema({
  show: ref('Show', { required: true, index: true }),
  artist: ref('Creator', { required: true, index: true }),
  title: { type: String, required: true },
  description: { type: String, default: '' },
  audio: { type: String, required: true },
  mime: { type: String, default: 'audio/mpeg' },
  durationMs: { type: Number, default: 0 },
  season: { type: Number, default: 1 },
  number: { type: Number, default: 1 },
  transcript: { type: String, default: '' },
  plays: { type: Number, default: 0 },
  published: { type: Boolean, default: true },
  hidden: { type: Boolean, default: false },
  publishedAt: { type: Date, default: Date.now, index: true },
}));

/* ------------------------------ Listener library ------------------------------ */

export const Playlist = model('Playlist', new Schema({
  user: ref('User', { required: true, index: true }),
  title: { type: String, required: true },
  description: { type: String, default: '' },
  isPublic: { type: Boolean, default: false },
  items: [{ _id: false, track: ref('Track'), addedAt: { type: Date, default: Date.now } }],
}, { timestamps: true }));

const pair = (a, b, name) => {
  const s = new Schema({ user: ref('User', { required: true }), [b]: ref(name, { required: true }) }, createdOnly);
  s.index({ user: 1, [b]: 1 }, { unique: true });
  s.index({ [b]: 1 });
  return s;
};
export const Like = model('Like', pair('user', 'track', 'Track'));
export const Follow = model('Follow', pair('user', 'artist', 'Creator'));
export const ShowFollow = model('ShowFollow', pair('user', 'show', 'Show'));
export const AlbumSave = model('AlbumSave', pair('user', 'album', 'Album'));

export const EpisodeProgress = (() => {
  const s = new Schema({
    user: ref('User', { required: true }),
    episode: ref('Episode', { required: true }),
    positionMs: { type: Number, default: 0 },
    completed: { type: Boolean, default: false },
  }, { timestamps: { createdAt: false, updatedAt: 'updatedAt' } });
  s.index({ user: 1, episode: 1 }, { unique: true });
  return model('EpisodeProgress', s);
})();

// Every counted listen. `creator` and `genre` are denormalised so stats need no joins.
export const Play = (() => {
  const s = new Schema({
    user: ref('User', { required: true }),
    kind: { type: String, enum: ['track', 'episode'], required: true },
    item: { type: Schema.Types.ObjectId, required: true },
    creator: ref('Creator'),
    genre: { type: String, default: '' },
    playedAt: { type: Date, default: Date.now },
    msPlayed: { type: Number, default: 0 },
    source: { type: String, default: '' },
  });
  s.index({ user: 1, playedAt: -1 });
  s.index({ kind: 1, item: 1, playedAt: -1 });
  s.index({ creator: 1, playedAt: -1 });
  return model('Play', s);
})();

export { mongoose };
