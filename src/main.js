import './style.css';
import Hls from 'hls.js';
import { parseM3U } from './m3u.js';
import { joinChannel, leaveChannel, watchViewerCount, viewersAvailable } from './firebase.js';

// ---------- Config (all consts up top, init() runs last — avoids TDZ order bugs) ----------

const DEFAULT_PLAYLISTS = [
  { url: 'https://iptv-org.github.io/iptv/index.m3u', label: 'Free TV (iptv-org)' },
  {
    url: 'https://raw.githubusercontent.com/ahan443/FAST-IPTV/refs/heads/main/FIFA.m3u',
    label: 'FIFA',
    forceGroup: 'Fifa',
  },
];

// Hand-picked direct FIFA broadcaster streams, always merged into the Fifa
// category (deduped by URL). Dead ones are skipped by the player's auto-failover.
const FIFA_LOGO = 'https://assets.football-logos.cc/logos/tournaments/1500x1500/fifa-world-cup-2026--white.10e0b37b.png';
const BUILTIN_FIFA_CHANNELS = [
  { name: 'FOX (USA)', url: 'https://cdn011.viaplus.site/fox-usa.m3u8' },
  { name: 'Telemundo (USA)', url: 'https://cdn011.viaplus.site/telemundo-usa.m3u8' },
  { name: 'TSN 1 (Canada)', url: 'https://cdn011.viaplus.site/tsn1-ca.m3u8' },
  { name: 'FOX 4K (USA)', url: 'https://cdn011.viaplus.site/fox4k-usa.m3u8' },
  { name: 'Fussball TV 1 UHD (Germany)', url: 'https://cdn011.viaplus.site/fussballtv1uhd-de.m3u8' },
  // Toffee's CDN sends no Access-Control-Allow-Origin, so a browser can't load
  // it directly — startStream() auto-retries through our proxy on failure.
  { name: 'Toffee FIFA HD (BD)', url: 'https://prod-cdn01-live.toffeelive.com/live/FIFA-2026-3/0/master_1750.m3u8?hdntl=Expires=1782866074~_GO=Generated~URLPrefix=aHR0cHM6Ly9wcm9kLWNkbjAxLWxpdmUudG9mZmVlbGl2ZS5jb20~Signature=AeQsclCGelVte2IiOGcwsJnkVmlh9kIGZARR9-eMUV_OPS2_vvtjSSYwO-FbiiXEh7epqBKkckq6D9zMuD4nm4j2BHQL' },
].map((c) => ({ ...c, group: 'Fifa', categories: ['Fifa'], logo: FIFA_LOGO, country: '' }));

// Backend CORS/mixed-content proxy (see server/). Falls back to it
// automatically when a stream fails to load directly.
const PROXY_BASE = import.meta.env.VITE_PROXY_BASE || 'http://localhost:8787';

function proxiedManifestUrl(url) {
  return `${PROXY_BASE}/proxy/m3u8?url=${encodeURIComponent(url)}`;
}

function proxiedSegmentUrl(url) {
  return `${PROXY_BASE}/proxy/segment?url=${encodeURIComponent(url)}`;
}

const CACHE_KEY = 'livetv-channel-cache-v2';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 25000; // the iptv-org playlist is ~2.7MB; a slow CDN moment needs headroom
const PAGE_SIZE = 150;
const RECENTS_KEY = 'livetv-recent-channels';
const RECENTS_MAX = 10;
const VOLUME_KEY = 'livetv-volume-pref';
const CUSTOM_KEY = 'livetv-custom-channels';
const SPORTSDB_EVENTS_BASE = 'https://www.thesportsdb.com/api/v1/json/3/eventsday.php';

const EVENT_ICONS = {
  Fifa: '⚽',
  Sports: '🏆',
  News: '📰',
  Movies: '🎬',
  Music: '🎵',
  Kids: '🧸',
  Animation: '🎨',
  Entertainment: '✨',
};

let regionNames = null;
try {
  regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
} catch {
  regionNames = null;
}

function countryName(code) {
  if (!code) return 'Other';
  try {
    return (regionNames && regionNames.of(code)) || code;
  } catch {
    return code;
  }
}

// A few playlist country codes don't match ISO-3166 alpha-2 (what flagcdn uses).
const FLAG_CODE_ALIASES = { UK: 'gb' };

function flagImg(code, size = '48x36') {
  if (!code || code.length !== 2) return '<span class="flag-fallback">🌍</span>';
  const cc = (FLAG_CODE_ALIASES[code.toUpperCase()] || code).toLowerCase();
  return `<img class="flag-img" src="https://flagcdn.com/${size}/${cc}.png" alt="${escapeHtml(code)}" onerror="this.outerHTML='<span class=\\'flag-fallback\\'>🌍</span>'" />`;
}

// ---------- DOM ----------

const app = document.querySelector('#app');

app.innerHTML = `
  <header class="header">
    <div class="logo"><span class="dot"></span><span class="logo-text">LiveTV</span></div>
    <nav class="menu">
      <button class="menu-item active" data-view="home">Home</button>
      <button class="menu-item" data-view="browse">Live TV</button>
      <button class="menu-item" data-view="fifa-tv">🏆 FIFA 2026</button>
      <button class="menu-item" data-view="fifa">⚽ Schedule</button>
    </nav>
    <button id="add-channel-btn" class="add-channel-btn" title="Add your own channel">＋ Add</button>
    <div class="country-select-wrap">
      <button id="country-select-btn" class="country-select-btn">
        <span id="country-select-flag">🇧🇩</span>
        <span id="country-select-label">Bangladesh</span>
        <span class="caret">▾</span>
      </button>
      <div id="country-dropdown" class="country-dropdown" style="display:none">
        <input id="country-search-input" class="country-search-input" type="text" placeholder="Find a country..." />
        <div id="country-dropdown-list" class="country-dropdown-list"></div>
      </div>
    </div>
    <div class="search-wrap">
      <input id="search-input" class="search-box" type="text" placeholder="Search anything... ( / )" />
      <div id="search-results" class="search-results" style="display:none"></div>
    </div>
    <span id="status-pill" class="status-pill">Loading free channels...</span>
  </header>

  <main id="view-root">
    <section id="home-view" class="view home-view">
      <div class="hero" id="hero">
        <div class="hero-slides" id="hero-slides"></div>
        <div class="hero-dots" id="hero-dots"></div>
        <button id="hero-prev" class="hero-arrow left">‹</button>
        <button id="hero-next" class="hero-arrow right">›</button>
        <div class="upcoming-widget" id="upcoming-widget" style="display:none">
          <div class="upcoming-title">Upcoming</div>
          <div id="upcoming-list"></div>
        </div>
      </div>

      <div class="home-section" id="recents-section" style="display:none">
        <h3 class="section-title">Continue Watching</h3>
        <div id="recents-row" class="recents-row"></div>
      </div>

      <div class="home-section">
        <h3 class="section-title">Live Events</h3>
        <p class="home-sub" id="home-sub">Loading live events...</p>
        <div id="event-cards" class="event-cards"></div>
      </div>

      <div class="home-section" id="fifa-section" style="display:none">
        <h3 class="section-title">⚽ FIFA World Cup — Results &amp; Schedule</h3>
        <div class="fifa-tabs" id="fifa-tabs"></div>
        <div id="fifa-schedule" class="fifa-schedule"></div>
      </div>

      <div class="home-section" id="trending-cat-section" style="display:none">
        <h3 class="section-title">Browse by Category</h3>
        <p class="home-sub">Jump straight into the channels you're after.</p>
        <div id="trending-cat-grid" class="trending-cat-grid"></div>
      </div>

      <div class="home-section" id="popular-country-section" style="display:none">
        <h3 class="section-title">Popular Countries</h3>
        <p class="home-sub">Browse free TV by country.</p>
        <div id="popular-country-grid" class="popular-country-grid"></div>
      </div>
    </section>

    <section id="browse-view" class="view browse-view" style="display:none">
      <div id="categories" class="categories"></div>
      <div id="channel-grid" class="channel-grid"></div>
    </section>

    <section id="fifa-view" class="view fifa-view" style="display:none">
      <div class="fifa-view-header">
        <h2 class="section-title">⚽ FIFA World Cup 2026</h2>
        <p class="home-sub" id="fifa-full-sub">Loading full schedule...</p>
        <div class="fifa-section-tabs" id="fifa-section-tabs">
          <button class="fifa-section-tab active" data-section="matches">Matches</button>
          <button class="fifa-section-tab" data-section="table">Table</button>
          <button class="fifa-section-tab" data-section="knockout">Knockout</button>
        </div>
      </div>

      <div id="fifa-matches-pane" class="fifa-pane">
        <div class="fifa-view-controls">
          <input id="fifa-search-input" class="search-box" type="text" placeholder="Filter by team..." />
          <div class="fifa-filter-tabs" id="fifa-filter-tabs">
            <button class="fifa-tab active" data-filter="all">All</button>
            <button class="fifa-tab" data-filter="results">Results</button>
            <button class="fifa-tab" data-filter="upcoming">Upcoming</button>
          </div>
        </div>
        <div id="fifa-full-schedule" class="fifa-full-schedule"></div>
      </div>

      <div id="fifa-table-pane" class="fifa-pane" style="display:none">
        <div id="fifa-table-groups" class="fifa-table-groups"></div>
      </div>

      <div id="fifa-knockout-pane" class="fifa-pane" style="display:none">
        <div id="fifa-knockout-schedule" class="fifa-full-schedule"></div>
      </div>
    </section>

    <section id="player-view" class="view player-view" style="display:none">
      <button id="back-btn" class="back-btn">← Back</button>
      <div class="player-wrap" id="player-wrap">
        <video id="video" playsinline></video>
        <div id="spinner" class="spinner" style="display:none"></div>
        <div id="controls" class="controls">
          <div class="controls-row top">
            <span id="net-quality-badge" class="net-quality-badge" style="display:none"></span>
            <span id="quality-badge" class="quality-badge">AUTO</span>
          </div>
          <div class="controls-row bottom">
            <button id="prev-channel-btn" class="ctrl-btn" title="Previous channel (B)">⏮</button>
            <button id="play-btn" class="ctrl-btn" title="Play/Pause (Space)">▶</button>
            <button id="next-channel-btn" class="ctrl-btn" title="Next channel (N)">⏭</button>
            <button id="mute-btn" class="ctrl-btn" title="Mute/Unmute (M)">🔊</button>
            <input id="volume" class="volume-slider" type="range" min="0" max="1" step="0.05" value="1" />
            <span id="live-badge" class="live-badge">● LIVE</span>
            <div class="spacer"></div>
            <button id="shortcuts-btn" class="ctrl-btn" title="Keyboard shortcuts">⌨</button>
            <select id="quality-select" class="quality-select" title="Quality"></select>
            <button id="pip-btn" class="ctrl-btn" title="Picture-in-Picture (P)">⧉</button>
            <button id="fullscreen-btn" class="ctrl-btn" title="Fullscreen (F)">⛶</button>
          </div>
        </div>
        <div id="shortcuts-panel" class="shortcuts-panel" style="display:none">
          <div><kbd>Space</kbd> Play / Pause</div>
          <div><kbd>M</kbd> Mute</div>
          <div><kbd>F</kbd> Fullscreen</div>
          <div><kbd>P</kbd> Picture-in-Picture</div>
          <div><kbd>↑</kbd>/<kbd>↓</kbd> Volume</div>
          <div><kbd>N</kbd>/<kbd>B</kbd> Next / Previous channel</div>
        </div>
      </div>
      <div class="player-bar">
        <div class="now-playing">
          <span id="np-name" class="now-playing-name">Nothing playing</span>
          <span id="np-group" class="now-playing-group"></span>
        </div>
        <span id="viewer-count" class="viewer-count" style="display:none">👁 <span id="viewer-count-num">0</span> watching</span>
        <span id="net-status" class="status-pill"></span>
      </div>
    </section>
  </main>

  <div id="add-modal" class="modal-overlay" style="display:none">
    <div class="modal-card">
      <div class="modal-head">
        <h3>Add a channel</h3>
        <button id="add-modal-close" class="modal-close" title="Close">✕</button>
      </div>
      <div class="modal-body">
        <label class="field">
          <span>Channel name</span>
          <input id="add-name" type="text" placeholder="e.g. Toffee FIFA HD" />
        </label>
        <label class="field">
          <span>Stream URL (.m3u8 or .ts)</span>
          <input id="add-url" type="text" placeholder="https://…/playlist.m3u8" />
        </label>
        <label class="field">
          <span>Category</span>
          <input id="add-category" type="text" value="Fifa" placeholder="Fifa" />
        </label>
        <label class="field">
          <span>Logo URL (optional)</span>
          <input id="add-logo" type="text" placeholder="https://…/logo.png" />
        </label>
        <div id="add-error" class="add-error"></div>
        <button id="add-save" class="btn-primary">Save channel</button>
        <p class="add-note">Tokenized links (e.g. Toffee) expire after a few hours — just re-add with a fresh URL when that happens. Saved only in this browser.</p>
      </div>
      <div id="add-existing" class="add-existing"></div>
    </div>
  </div>
`;

const menuItems = document.querySelectorAll('.menu-item');
const searchInput = document.querySelector('#search-input');
const searchResultsEl = document.querySelector('#search-results');
const statusPill = document.querySelector('#status-pill');

const addChannelBtn = document.querySelector('#add-channel-btn');
const addModal = document.querySelector('#add-modal');
const addModalClose = document.querySelector('#add-modal-close');
const addNameInput = document.querySelector('#add-name');
const addUrlInput = document.querySelector('#add-url');
const addCategoryInput = document.querySelector('#add-category');
const addLogoInput = document.querySelector('#add-logo');
const addErrorEl = document.querySelector('#add-error');
const addSaveBtn = document.querySelector('#add-save');
const addExistingEl = document.querySelector('#add-existing');

const countrySelectBtn = document.querySelector('#country-select-btn');
const countrySelectFlag = document.querySelector('#country-select-flag');
const countrySelectLabel = document.querySelector('#country-select-label');
const countryDropdown = document.querySelector('#country-dropdown');
const countryDropdownList = document.querySelector('#country-dropdown-list');
const countrySearchInput = document.querySelector('#country-search-input');

const homeView = document.querySelector('#home-view');
const heroSlidesEl = document.querySelector('#hero-slides');
const heroDotsEl = document.querySelector('#hero-dots');
const heroPrevBtn = document.querySelector('#hero-prev');
const heroNextBtn = document.querySelector('#hero-next');
const upcomingWidget = document.querySelector('#upcoming-widget');
const upcomingListEl = document.querySelector('#upcoming-list');
const homeSub = document.querySelector('#home-sub');
const eventCardsEl = document.querySelector('#event-cards');
const fifaSection = document.querySelector('#fifa-section');
const fifaTabsEl = document.querySelector('#fifa-tabs');
const fifaScheduleEl = document.querySelector('#fifa-schedule');
const recentsSection = document.querySelector('#recents-section');
const recentsRowEl = document.querySelector('#recents-row');
const trendingCatSection = document.querySelector('#trending-cat-section');
const trendingCatGridEl = document.querySelector('#trending-cat-grid');
const popularCountrySection = document.querySelector('#popular-country-section');
const popularCountryGridEl = document.querySelector('#popular-country-grid');

const browseView = document.querySelector('#browse-view');
const categoriesEl = document.querySelector('#categories');
const channelGridEl = document.querySelector('#channel-grid');

const fifaView = document.querySelector('#fifa-view');
const fifaFullSub = document.querySelector('#fifa-full-sub');
const fifaSearchInput = document.querySelector('#fifa-search-input');
const fifaFilterTabsEl = document.querySelector('#fifa-filter-tabs');
const fifaFullScheduleEl = document.querySelector('#fifa-full-schedule');
const fifaSectionTabsEl = document.querySelector('#fifa-section-tabs');
const fifaMatchesPane = document.querySelector('#fifa-matches-pane');
const fifaTablePane = document.querySelector('#fifa-table-pane');
const fifaKnockoutPane = document.querySelector('#fifa-knockout-pane');
const fifaTableGroupsEl = document.querySelector('#fifa-table-groups');
const fifaKnockoutScheduleEl = document.querySelector('#fifa-knockout-schedule');

const playerView = document.querySelector('#player-view');
const backBtn = document.querySelector('#back-btn');
const playerWrap = document.querySelector('#player-wrap');
const video = document.querySelector('#video');
const spinner = document.querySelector('#spinner');
const controls = document.querySelector('#controls');
const npName = document.querySelector('#np-name');
const npGroup = document.querySelector('#np-group');
const liveBadge = document.querySelector('#live-badge');
const netStatus = document.querySelector('#net-status');
const playBtn = document.querySelector('#play-btn');
const muteBtn = document.querySelector('#mute-btn');
const volumeSlider = document.querySelector('#volume');
const qualitySelect = document.querySelector('#quality-select');
const qualityBadge = document.querySelector('#quality-badge');
const pipBtn = document.querySelector('#pip-btn');
const fullscreenBtn = document.querySelector('#fullscreen-btn');
const viewerCountEl = document.querySelector('#viewer-count');
const viewerCountNum = document.querySelector('#viewer-count-num');
const prevChannelBtn = document.querySelector('#prev-channel-btn');
const nextChannelBtn = document.querySelector('#next-channel-btn');
const shortcutsBtn = document.querySelector('#shortcuts-btn');
const shortcutsPanel = document.querySelector('#shortcuts-panel');
const netQualityBadge = document.querySelector('#net-quality-badge');

// ---------- State ----------

let allChannels = [];
let baseChannels = []; // playlist-loaded channels (before custom ones are merged in)
let activeCountry = 'BD';
let activeCategory = 'All';
let currentChannel = null;
let currentChannelKey = null;
let unwatchViewers = null;
let hls = null;
let tsPlayer = null;
let streamActive = false; // true only while actively attempting/playing a stream
let retryTimer = null;
let retryCount = 0;
let autoFailoverAttempts = 0; // how many dead channels we've auto-skipped in a row
const MAX_AUTO_FAILOVER = 10;
let failoverTimer = null;
let watchdogTimer = null;
let slowNoticeTimer = null;
let visibleCount = PAGE_SIZE;
let lastFiltered = [];
let netQualityTimer = null;
let heroEvents = [];
let heroIndex = 0;
let heroTimer = null;
let countdownTimer = null;

// ---------- View routing ----------

function showView(name) {
  homeView.style.display = name === 'home' ? 'flex' : 'none';
  browseView.style.display = name === 'browse' ? 'flex' : 'none';
  fifaView.style.display = name === 'fifa' ? 'flex' : 'none';
  playerView.style.display = name === 'player' ? 'flex' : 'none';
  menuItems.forEach((el) => el.classList.toggle('active', el.dataset.view === name));
  hideSearchResults();
  shortcutsPanel.style.display = 'none';

  if (name !== 'player') {
    stopStream();
    stopViewerWatch();
  }
}

menuItems.forEach((el) => {
  el.addEventListener('click', () => {
    if (el.dataset.view === 'fifa-tv') {
      enterCategoryFromHome('Fifa');
      return;
    }
    if (el.dataset.view === 'browse') enterBrowse();
    if (el.dataset.view === 'fifa') enterFifaSchedule();
    showView(el.dataset.view);
  });
});

function enterBrowse() {
  activeCategory = 'All';
  visibleCount = PAGE_SIZE;
  renderCategories();
  renderChannelGrid();
}

backBtn.addEventListener('click', () => {
  renderCategories();
  renderChannelGrid();
  showView('browse');
});

// ---------- Data loading ----------

setActiveCountry('BD');
initPlaylists();
loadLiveEvents();
loadFifaSchedule();
renderRecents();

async function initPlaylists() {
  const cached = readCache();
  if (cached) {
    baseChannels = cached;
    rebuildAllChannels();
    setStatus(`${cached.length} channels loaded (cached)`);
  }

  const groups = [];
  let anyFailed = false;
  for (const pl of DEFAULT_PLAYLISTS) {
    try {
      const channels = await fetchAndParse(pl.url, pl.forceGroup);
      groups.push(channels);
    } catch (err) {
      anyFailed = true;
      console.warn(`Failed to load ${pl.label}:`, err.message);
    }
  }
  const merged = dedupe(groups.flat());

  // Guard against a partial load (e.g. a slow CDN timing out) clobbering a
  // good cache with far fewer channels. Only replace/cache the fresh result
  // when everything loaded, or when it's at least as complete as the cache.
  const safeToReplace = merged.length && (!anyFailed || !cached || merged.length >= cached.length);
  if (safeToReplace) {
    baseChannels = merged;
    setStatus(`${merged.length} channels loaded`);
    writeCache(merged);
  } else if (cached) {
    baseChannels = cached;
    setStatus(`${cached.length} channels loaded`);
  } else {
    setStatus('Failed to load default playlists', true);
  }

  rebuildAllChannels();
  renderCountryDropdown();
  renderTrendingCategories();
  renderPopularCountries();
  if (browseView.style.display !== 'none') {
    renderCategories();
    renderChannelGrid();
  }
}

// allChannels = user's custom channels (first, so they sort to the top of
// their category) + the playlist-loaded ones. Custom channels survive the
// periodic playlist refresh because they're re-merged here every time.
function rebuildAllChannels() {
  allChannels = dedupe([...readCustomChannels(), ...BUILTIN_FIFA_CHANNELS, ...baseChannels]);
}

function readCustomChannels() {
  try {
    const arr = JSON.parse(localStorage.getItem(CUSTOM_KEY)) || [];
    return arr.map((c) => ({
      name: c.name,
      url: c.url,
      logo: c.logo || '',
      group: c.group || 'Fifa',
      categories: c.categories && c.categories.length ? c.categories : [c.group || 'Fifa'],
      country: c.country || '',
      custom: true,
    }));
  } catch {
    return [];
  }
}

function writeCustomChannels(list) {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
  } catch {
    // ignore quota errors
  }
}

function rawCustomList() {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_KEY)) || [];
  } catch {
    return [];
  }
}

// ---------- Add-channel modal ----------

function refreshAfterCustomChange() {
  rebuildAllChannels();
  renderCountryDropdown();
  renderTrendingCategories();
  if (browseView.style.display !== 'none') {
    renderCategories();
    renderChannelGrid();
  }
}

function openAddModal() {
  addErrorEl.textContent = '';
  renderExistingCustom();
  addModal.style.display = 'flex';
  addNameInput.focus();
}

function closeAddModal() {
  addModal.style.display = 'none';
}

addChannelBtn.addEventListener('click', openAddModal);
addModalClose.addEventListener('click', closeAddModal);
addModal.addEventListener('click', (e) => {
  if (e.target === addModal) closeAddModal();
});

addSaveBtn.addEventListener('click', () => {
  const name = addNameInput.value.trim();
  const url = addUrlInput.value.trim();
  const category = addCategoryInput.value.trim() || 'Fifa';
  const logo = addLogoInput.value.trim();

  if (!name) {
    addErrorEl.textContent = 'Please enter a channel name.';
    return;
  }
  if (!/^https?:\/\/.+/i.test(url)) {
    addErrorEl.textContent = 'Please enter a valid stream URL starting with http:// or https://';
    return;
  }

  const list = rawCustomList().filter((c) => c.url !== url); // de-dupe by URL
  list.unshift({ name, url, group: category, categories: [category], logo });
  writeCustomChannels(list);
  refreshAfterCustomChange();

  addNameInput.value = '';
  addUrlInput.value = '';
  addLogoInput.value = '';
  addCategoryInput.value = 'Fifa';
  addErrorEl.textContent = '';
  renderExistingCustom();

  // Start watching the newly added channel right away.
  const ch = allChannels.find((c) => c.url === url);
  if (ch) {
    closeAddModal();
    playChannel(ch);
  }
});

function renderExistingCustom() {
  const list = rawCustomList();
  if (!list.length) {
    addExistingEl.innerHTML = '';
    return;
  }
  addExistingEl.innerHTML =
    `<div class="add-existing-title">Your channels (${list.length})</div>` +
    list
      .map(
        (c, i) => `
        <div class="add-existing-row">
          <span class="add-existing-name">${escapeHtml(c.name)} <span class="add-existing-cat">${escapeHtml(c.group || 'Fifa')}</span></span>
          <button class="add-existing-del" data-i="${i}" title="Remove">🗑</button>
        </div>`
      )
      .join('');

  addExistingEl.querySelectorAll('.add-existing-del').forEach((el) => {
    el.addEventListener('click', () => {
      const cur = rawCustomList();
      cur.splice(parseInt(el.dataset.i, 10), 1);
      writeCustomChannels(cur);
      refreshAfterCustomChange();
      renderExistingCustom();
    });
  });
}

async function fetchAndParse(url, forceGroup) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const channels = parseM3U(text);
    if (forceGroup) {
      for (const c of channels) {
        c.group = forceGroup;
        c.categories = [forceGroup];
      }
    }
    return channels;
  } finally {
    clearTimeout(timer);
  }
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { timestamp, channels } = JSON.parse(raw);
    if (!Array.isArray(channels) || Date.now() - timestamp > CACHE_TTL_MS) return null;
    return channels;
  } catch {
    return null;
  }
}

function writeCache(channels) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ timestamp: Date.now(), channels }));
  } catch {
    // ignore quota errors — cache is a nice-to-have, not required
  }
}

function dedupe(channels) {
  const seen = new Set();
  const result = [];
  for (const c of channels) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    result.push(c);
  }
  return result;
}

function setStatus(text, isError = false) {
  statusPill.textContent = text;
  statusPill.style.color = isError ? 'var(--danger)' : 'var(--text-dim)';
}

function setNetStatus(text, isError = false) {
  netStatus.textContent = text;
  netStatus.style.color = isError ? 'var(--danger)' : 'var(--text-dim)';
}

// ---------- Home: hero carousel + real live events from TheSportsDB ----------

const BD_TIMEZONE = 'Asia/Dhaka';

function matchWindow(ev) {
  if (!ev.dateEvent || !ev.strTime) return { started: false, finished: false };
  // strTime/dateEvent from TheSportsDB are UTC — the "Z" suffix is required,
  // otherwise this gets parsed as the viewer's local time and every
  // countdown/kickoff time silently shifts by their UTC offset.
  const start = new Date(`${ev.dateEvent}T${ev.strTime}Z`);
  if (Number.isNaN(start.getTime())) return { started: false, finished: false };
  const now = new Date();
  const elapsedMs = now - start;
  return {
    started: elapsedMs >= 0,
    finished: elapsedMs > 2.5 * 60 * 60 * 1000, // assume ~2.5h covers full match + stoppage
    start,
  };
}

function fmtTimeBD(date) {
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: BD_TIMEZONE });
}

function fmtDateBD(date) {
  return date.toLocaleDateString('en-GB', { weekday: 'short', month: 'short', day: 'numeric', timeZone: BD_TIMEZONE });
}

async function loadLiveEvents() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${SPORTSDB_EVENTS_BASE}?d=${today}&s=Soccer`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const events = ((data && data.events) || []).filter((ev) => !matchWindow(ev).finished);

    if (events.length) {
      heroEvents = events.slice(0, 6);
      homeSub.textContent = 'Real football fixtures for today (via TheSportsDB) — pick one to see Fifa channels.';
      renderHero();
      renderUpcomingWidget();
      eventCardsEl.innerHTML = events
        .slice(0, 12)
        .map((ev) => eventCardHtml(ev))
        .join('');
      wireEventCards();
      return;
    }
    throw new Error('No fixtures returned for today');
  } catch (err) {
    heroSlidesEl.innerHTML = '';
    heroDotsEl.innerHTML = '';
    upcomingWidget.style.display = 'none';
    buildFallbackEventCards(err.message);
  }
}

function eventCardHtml(ev) {
  const home = ev.strHomeTeam || 'Home';
  const away = ev.strAwayTeam || 'Away';
  const league = ev.strLeague || 'Football';
  const { started, start } = matchWindow(ev);
  const score = started && ev.intHomeScore != null && ev.intAwayScore != null ? `${ev.intHomeScore} - ${ev.intAwayScore}` : null;
  const timeLabel = start ? fmtTimeBD(start) : ev.strTime || '';
  const statusTag = started
    ? `<span class="event-live-tag">● LIVE</span> ${score ? escapeHtml(score) : ''}`
    : `Kicks off ${escapeHtml(timeLabel)}`;
  return `
    <div class="event-card${started ? ' live' : ''}" data-category="Fifa">
      <div class="event-icon">⚽</div>
      <div class="event-info">
        <div class="event-name">${escapeHtml(home)} vs ${escapeHtml(away)}</div>
        <div class="event-meta">${statusTag} · ${escapeHtml(league)}</div>
      </div>
    </div>`;
}

function renderHero() {
  if (!heroEvents.length) return;
  heroSlidesEl.innerHTML = heroEvents
    .map((ev, i) => {
      const home = ev.strHomeTeam || 'Home';
      const away = ev.strAwayTeam || 'Away';
      const banner = ev.strBanner || ev.strFanart || ev.strThumb || '';
      const { started, start } = matchWindow(ev);
      return `
        <div class="hero-slide${i === 0 ? ' active' : ''}" data-idx="${i}">
          <div class="hero-bg" style="${banner ? `background-image:url('${escapeHtml(banner)}')` : ''}"></div>
          <div class="hero-overlay"></div>
          <div class="hero-content">
            <div class="hero-league">${escapeHtml(ev.strLeague || 'Football')}</div>
            <div class="hero-teams">
              ${ev.strHomeTeamBadge ? `<img class="hero-badge" src="${escapeHtml(ev.strHomeTeamBadge)}" />` : ''}
              <span class="hero-vs">${escapeHtml(home)} <span class="vs-text">vs</span> ${escapeHtml(away)}</span>
              ${ev.strAwayTeamBadge ? `<img class="hero-badge" src="${escapeHtml(ev.strAwayTeamBadge)}" />` : ''}
            </div>
            ${started ? `<div class="hero-live-tag">● LIVE NOW</div>` : `<div class="hero-countdown" data-start="${start ? start.getTime() : ''}">--:--:--</div>`}
            <button class="hero-cta" data-category="Fifa">${started ? 'Watch Now' : 'Remind Me'}</button>
          </div>
        </div>`;
    })
    .join('');

  heroDotsEl.innerHTML = heroEvents.map((_, i) => `<span class="hero-dot${i === 0 ? ' active' : ''}" data-idx="${i}"></span>`).join('');

  heroDotsEl.querySelectorAll('.hero-dot').forEach((el) => {
    el.addEventListener('click', () => goToHeroSlide(parseInt(el.dataset.idx, 10)));
  });

  heroSlidesEl.querySelectorAll('.hero-cta').forEach((btn, i) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ev = heroEvents[i];
      const { started } = matchWindow(ev);
      if (started) {
        activeCategory = 'Fifa';
        enterCategoryFromHome('Fifa');
      } else {
        requestReminder(ev);
      }
    });
  });

  clearInterval(heroTimer);
  heroTimer = setInterval(() => {
    if (homeView.style.display === 'none') return; // don't rotate while off the home view
    goToHeroSlide((heroIndex + 1) % heroEvents.length);
  }, 6000);
  clearInterval(countdownTimer);
  tickCountdowns();
  countdownTimer = setInterval(tickCountdowns, 1000);
}

function goToHeroSlide(i) {
  heroIndex = i;
  heroSlidesEl.querySelectorAll('.hero-slide').forEach((el, idx) => {
    el.classList.toggle('active', idx === i);
    if (idx === i) {
      // restart the content entrance + background zoom animations each time a slide becomes active
      const content = el.querySelector('.hero-content');
      const bg = el.querySelector('.hero-bg');
      [content, bg].forEach((node) => {
        if (!node) return;
        node.style.animation = 'none';
        void node.offsetWidth;
        node.style.animation = '';
      });
    }
  });
  heroDotsEl.querySelectorAll('.hero-dot').forEach((el, idx) => el.classList.toggle('active', idx === i));
}

heroPrevBtn.addEventListener('click', () => goToHeroSlide((heroIndex - 1 + heroEvents.length) % heroEvents.length));
heroNextBtn.addEventListener('click', () => goToHeroSlide((heroIndex + 1) % heroEvents.length));

function tickCountdowns() {
  if (homeView.style.display === 'none') return; // skip DOM work while the home view is hidden
  document.querySelectorAll('.hero-countdown[data-start]').forEach((el) => {
    const startMs = parseInt(el.dataset.start, 10);
    if (!startMs) return;
    const diff = startMs - Date.now();
    if (diff <= 0) {
      el.textContent = 'Starting now';
      return;
    }
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    el.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  });
  document.querySelectorAll('.upcoming-countdown[data-start]').forEach((el) => {
    const startMs = parseInt(el.dataset.start, 10);
    if (!startMs) return;
    const diff = startMs - Date.now();
    el.textContent = diff <= 0 ? 'Live' : formatShortCountdown(diff);
  });
}

function formatShortCountdown(diffMs) {
  const h = Math.floor(diffMs / 3600000);
  const m = Math.floor((diffMs % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function renderUpcomingWidget() {
  const upcoming = heroEvents.filter((ev) => !matchWindow(ev).started).slice(0, 4);
  if (!upcoming.length) {
    upcomingWidget.style.display = 'none';
    return;
  }
  upcomingWidget.style.display = 'block';
  upcomingListEl.innerHTML = upcoming
    .map((ev) => {
      const { start } = matchWindow(ev);
      return `
        <div class="upcoming-item">
          ${ev.strHomeTeamBadge ? `<img class="upcoming-badge" src="${escapeHtml(ev.strHomeTeamBadge)}" />` : '<span class="upcoming-badge-fallback">⚽</span>'}
          <span class="upcoming-countdown" data-start="${start ? start.getTime() : ''}">--</span>
          ${ev.strAwayTeamBadge ? `<img class="upcoming-badge" src="${escapeHtml(ev.strAwayTeamBadge)}" />` : '<span class="upcoming-badge-fallback">⚽</span>'}
        </div>`;
    })
    .join('');
}

function requestReminder(ev) {
  if (!('Notification' in window)) {
    alert('Reminders need browser notification support, which this browser does not have.');
    return;
  }
  Notification.requestPermission().then((perm) => {
    if (perm !== 'granted') return;
    const { start } = matchWindow(ev);
    if (!start) return;
    const delay = start.getTime() - Date.now();
    if (delay <= 0) return;
    setTimeout(() => {
      new Notification(`${ev.strHomeTeam} vs ${ev.strAwayTeam} is starting!`, {
        body: ev.strLeague || 'Kickoff time',
      });
    }, delay);
    alert('Reminder set — keep this tab open and you\'ll get a notification at kickoff.');
  });
}

function buildFallbackEventCards(reason) {
  homeSub.textContent = reason
    ? `No live matches from the sports API right now (${reason}). Showing trending categories instead.`
    : 'Pick a category to see its channels.';

  const wait = () => {
    if (!allChannels.length) {
      setTimeout(wait, 300);
      return;
    }
    const counts = new Map();
    for (const c of allChannels) {
      for (const cat of c.categories || [c.group]) counts.set(cat, (counts.get(cat) || 0) + 1);
    }
    const groups = [...counts.keys()].filter((g) => g !== 'Undefined');
    const featured = counts.has('Fifa') ? ['Fifa'] : [];
    const rest = groups
      .filter((g) => g !== 'Fifa')
      .sort((a, b) => counts.get(b) - counts.get(a))
      .slice(0, 7);
    const cards = [...featured, ...rest];

    eventCardsEl.innerHTML = cards
      .map((g) => {
        const isLive = g === 'Fifa';
        return `
          <div class="event-card${isLive ? ' live' : ''}" data-category="${escapeHtml(g)}">
            <div class="event-icon">${eventIcon(g)}</div>
            <div class="event-info">
              <div class="event-name">${escapeHtml(g)}</div>
              <div class="event-meta">${isLive ? '<span class="event-live-tag">● LIVE NOW</span>' : 'Trending'} · ${counts.get(g)} channels</div>
            </div>
          </div>`;
      })
      .join('');
    wireEventCards();
  };
  wait();
}

function wireEventCards() {
  eventCardsEl.querySelectorAll('.event-card').forEach((el) => {
    el.addEventListener('click', () => enterCategoryFromHome(el.dataset.category));
  });
}

function enterCategoryFromHome(category) {
  setActiveCountry('All');
  activeCategory = category;
  visibleCount = PAGE_SIZE;
  renderCategories();
  renderChannelGrid();
  showView('browse');
}

function eventIcon(group) {
  return EVENT_ICONS[group] || '📡';
}

// ---------- Fifa results & schedule (grouped by World Cup group) ----------

let fifaBuckets = {};
let fifaActiveTab = 'today';

function isoDateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function fetchEventsForDate(dateStr) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${SPORTSDB_EVENTS_BASE}?d=${dateStr}&s=Soccer`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data && data.events) || [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function loadFifaSchedule() {
  const [yesterday, today, tomorrow] = await Promise.all([
    fetchEventsForDate(isoDateOffset(-1)),
    fetchEventsForDate(isoDateOffset(0)),
    fetchEventsForDate(isoDateOffset(1)),
  ]);

  const results = yesterday.filter((ev) => matchWindow(ev).finished || (ev.intHomeScore != null && matchWindow(ev).started));
  const todayMatches = today;
  const tomorrowMatches = tomorrow;

  fifaBuckets = { results, today: todayMatches, tomorrow: tomorrowMatches };

  if (!results.length && !todayMatches.length && !tomorrowMatches.length) {
    fifaSection.style.display = 'none';
    return;
  }

  fifaSection.style.display = 'block';
  fifaActiveTab = todayMatches.length ? 'today' : results.length ? 'results' : 'tomorrow';
  renderFifaTabs();
  renderFifaSchedule();
}

// ---------- Full FIFA World Cup 2026 schedule (whole tournament, paginated by day) ----------

const FIFA_SCHEDULE_CACHE_KEY = 'livetv-fifa-full-schedule-v1';
const FIFA_SCHEDULE_TTL_MS = 6 * 60 * 60 * 1000;
const FIFA_TOURNAMENT_START = '2026-06-11';
const FIFA_TOURNAMENT_END = '2026-07-19';

let fullFifaEvents = null;
let fifaFullFilter = 'all';
let fifaFullLoading = false;

function dateRange(startStr, endStr) {
  const dates = [];
  const cur = new Date(startStr);
  const end = new Date(endStr);
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

async function fetchInBatches(dates, batchSize = 6) {
  const results = [];
  for (let i = 0; i < dates.length; i += batchSize) {
    const batch = dates.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fetchEventsForDate));
    results.push(...batchResults);
    fifaFullSub.textContent = `Loading schedule... (${Math.min(i + batchSize, dates.length)}/${dates.length} days)`;
  }
  return results.flat();
}

function readFifaScheduleCache() {
  try {
    const raw = localStorage.getItem(FIFA_SCHEDULE_CACHE_KEY);
    if (!raw) return null;
    const { timestamp, events } = JSON.parse(raw);
    if (!Array.isArray(events) || Date.now() - timestamp > FIFA_SCHEDULE_TTL_MS) return null;
    return events;
  } catch {
    return null;
  }
}

function writeFifaScheduleCache(events) {
  try {
    localStorage.setItem(FIFA_SCHEDULE_CACHE_KEY, JSON.stringify({ timestamp: Date.now(), events }));
  } catch {
    // ignore quota errors
  }
}

async function enterFifaSchedule() {
  if (fullFifaEvents) {
    renderFullFifaSchedule();
    return;
  }
  if (fifaFullLoading) return;
  fifaFullLoading = true;

  const cached = readFifaScheduleCache();
  if (cached) {
    fullFifaEvents = cached;
    fifaFullSub.textContent = `${cached.length} matches across the tournament (cached) — group stage through whichever rounds the data provider has published so far.`;
    renderFullFifaSchedule();
    fifaFullLoading = false;
    return;
  }

  fifaFullSub.textContent = 'Loading the full tournament schedule...';
  const dates = dateRange(FIFA_TOURNAMENT_START, FIFA_TOURNAMENT_END);
  const allEvents = await fetchInBatches(dates);
  const fifaOnly = dedupeByKey(allEvents.filter((ev) => ev.strLeague === 'FIFA World Cup'), 'idEvent');
  fifaOnly.sort((a, b) => `${a.dateEvent}${a.strTime}`.localeCompare(`${b.dateEvent}${b.strTime}`));

  fullFifaEvents = fifaOnly;
  writeFifaScheduleCache(fifaOnly);
  fifaFullSub.textContent = fifaOnly.length
    ? `${fifaOnly.length} matches found — group stage through whichever rounds the data provider has published so far. Knockout-round fixtures appear once earlier rounds are confirmed.`
    : 'No schedule data available right now — try again later.';
  renderFullFifaSchedule();
  fifaFullLoading = false;

  loadFifaTable();
}

fifaSectionTabsEl.querySelectorAll('.fifa-section-tab').forEach((el) => {
  el.addEventListener('click', () => {
    fifaSectionTabsEl.querySelectorAll('.fifa-section-tab').forEach((t) => t.classList.toggle('active', t === el));
    const section = el.dataset.section;
    fifaMatchesPane.style.display = section === 'matches' ? 'block' : 'none';
    fifaTablePane.style.display = section === 'table' ? 'block' : 'none';
    fifaKnockoutPane.style.display = section === 'knockout' ? 'block' : 'none';
    if (section === 'table') loadFifaTable();
    if (section === 'knockout') renderKnockout();
  });
});

let fifaTableLoaded = false;

async function loadFifaTable() {
  if (fifaTableLoaded) return;
  fifaTableGroupsEl.innerHTML = `<div class="empty-state"><div style="font-size:28px;">📊</div><div>Loading standings...</div></div>`;
  try {
    const res = await fetch('https://www.thesportsdb.com/api/v1/json/3/lookuptable.php?l=4429&s=2026');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const table = (data && data.table) || [];
    if (!table.length) throw new Error('No standings published yet');
    renderFifaTable(table);
    fifaTableLoaded = true;
  } catch (err) {
    fifaTableGroupsEl.innerHTML = `<div class="empty-state"><div style="font-size:28px;">📊</div><div>Standings aren't published yet (${escapeHtml(err.message)}).</div></div>`;
  }
}

function renderFifaTable(table) {
  const groups = new Map();
  for (const row of table) {
    const key = row.strGroup || 'Table';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  fifaTableGroupsEl.innerHTML = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([groupName, rows]) => {
      rows.sort((a, b) => parseInt(a.intRank, 10) - parseInt(b.intRank, 10));
      const body = rows
        .map(
          (r) => `
            <tr>
              <td class="fifa-table-rank">${escapeHtml(r.intRank)}</td>
              <td class="fifa-table-team"><img class="fifa-table-badge" src="${escapeHtml(r.strBadge || '')}" onerror="this.style.display='none'" />${escapeHtml(r.strTeam)}</td>
              <td>${escapeHtml(r.intPlayed)}</td>
              <td>${escapeHtml(r.intWin)}</td>
              <td>${escapeHtml(r.intDraw)}</td>
              <td>${escapeHtml(r.intLoss)}</td>
              <td>${escapeHtml(r.intGoalDifference)}</td>
              <td class="fifa-table-pts">${escapeHtml(r.intPoints)}</td>
            </tr>`
        )
        .join('');
      return `
        <div class="fifa-table-card">
          <div class="fifa-group-title">${escapeHtml(groupName)}</div>
          <table class="fifa-table">
            <thead><tr><th>#</th><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th></tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>`;
    })
    .join('');
}

function renderKnockout() {
  if (!fullFifaEvents) return;
  const knockoutMatches = fullFifaEvents.filter((ev) => parseInt(ev.intRound, 10) >= 4);

  if (!knockoutMatches.length) {
    fifaKnockoutScheduleEl.innerHTML = `<div class="empty-state"><div style="font-size:28px;">🏆</div><div>The knockout bracket isn't set yet — it unlocks once group-stage results decide who advances.</div></div>`;
    return;
  }

  const byRound = new Map();
  const roundNames = { 4: 'Round of 32', 5: 'Round of 16', 6: 'Quarter-finals', 7: 'Semi-finals', 8: 'Final' };
  for (const ev of knockoutMatches) {
    const key = roundNames[parseInt(ev.intRound, 10)] || `Round ${ev.intRound}`;
    if (!byRound.has(key)) byRound.set(key, []);
    byRound.get(key).push(ev);
  }

  fifaKnockoutScheduleEl.innerHTML = [...byRound.entries()]
    .map(([roundName, matches]) => {
      const rows = matches
        .map((ev) => {
          const { started, finished, start } = matchWindow(ev);
          const home = ev.strHomeTeam || 'TBD';
          const away = ev.strAwayTeam || 'TBD';
          const homeBadge = ev.strHomeTeamBadge ? `<img class="fifa-team-badge" src="${escapeHtml(ev.strHomeTeamBadge)}" />` : '<span class="fifa-team-badge-fallback">⚽</span>';
          const awayBadge = ev.strAwayTeamBadge ? `<img class="fifa-team-badge" src="${escapeHtml(ev.strAwayTeamBadge)}" />` : '<span class="fifa-team-badge-fallback">⚽</span>';
          const hasScore = ev.intHomeScore != null && ev.intAwayScore != null && (started || finished);
          const scoreOrTime = hasScore
            ? `<span class="fifa-score">${escapeHtml(ev.intHomeScore)} - ${escapeHtml(ev.intAwayScore)}</span>`
            : `<span class="fifa-time">${start ? escapeHtml(start.toLocaleDateString('en-GB', { month: 'short', day: 'numeric', timeZone: BD_TIMEZONE })) : ''}</span>`;
          return `
            <div class="fifa-row">
              <div class="fifa-team home">${homeBadge}<span class="fifa-team-name">${escapeHtml(home)}</span></div>
              <div class="fifa-center">${scoreOrTime}<span class="fifa-status${started && !finished ? ' live' : ''}">${finished ? 'FT' : started ? 'LIVE' : 'Scheduled'}</span></div>
              <div class="fifa-team away">${awayBadge}<span class="fifa-team-name">${escapeHtml(away)}</span></div>
            </div>`;
        })
        .join('');
      return `<div class="fifa-group"><div class="fifa-group-title">${escapeHtml(roundName)}</div>${rows}</div>`;
    })
    .join('');

  fifaKnockoutScheduleEl.querySelectorAll('.fifa-row').forEach((el) => {
    el.addEventListener('click', () => enterCategoryFromHome('Fifa'));
  });
}

function dedupeByKey(items, key) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (seen.has(item[key])) continue;
    seen.add(item[key]);
    out.push(item);
  }
  return out;
}

fifaFilterTabsEl.querySelectorAll('.fifa-tab').forEach((el) => {
  el.addEventListener('click', () => {
    fifaFullFilter = el.dataset.filter;
    fifaFilterTabsEl.querySelectorAll('.fifa-tab').forEach((t) => t.classList.toggle('active', t === el));
    renderFullFifaSchedule();
  });
});

fifaSearchInput.addEventListener('input', () => renderFullFifaSchedule());

function renderFullFifaSchedule() {
  if (!fullFifaEvents) return;
  const query = fifaSearchInput.value.trim().toLowerCase();

  let events = fullFifaEvents;
  if (fifaFullFilter === 'results') events = events.filter((ev) => matchWindow(ev).finished);
  if (fifaFullFilter === 'upcoming') events = events.filter((ev) => !matchWindow(ev).finished);
  if (query) {
    events = events.filter(
      (ev) => (ev.strHomeTeam || '').toLowerCase().includes(query) || (ev.strAwayTeam || '').toLowerCase().includes(query)
    );
  }

  if (!events.length) {
    fifaFullScheduleEl.innerHTML = `<div class="empty-state"><div style="font-size:28px;">⚽</div><div>No matches match this filter.</div></div>`;
    return;
  }

  const byDate = new Map();
  for (const ev of events) {
    if (!byDate.has(ev.dateEvent)) byDate.set(ev.dateEvent, []);
    byDate.get(ev.dateEvent).push(ev);
  }

  fifaFullScheduleEl.innerHTML = [...byDate.entries()]
    .map(([date, matches]) => {
      const dateLabel = fmtDateBD(new Date(`${date}T00:00:00Z`));
      const rows = matches
        .map((ev) => {
          const { started, finished, start } = matchWindow(ev);
          const home = ev.strHomeTeam || 'Home';
          const away = ev.strAwayTeam || 'Away';
          const homeBadge = ev.strHomeTeamBadge
            ? `<img class="fifa-team-badge" src="${escapeHtml(ev.strHomeTeamBadge)}" />`
            : '<span class="fifa-team-badge-fallback">⚽</span>';
          const awayBadge = ev.strAwayTeamBadge
            ? `<img class="fifa-team-badge" src="${escapeHtml(ev.strAwayTeamBadge)}" />`
            : '<span class="fifa-team-badge-fallback">⚽</span>';
          const hasScore = ev.intHomeScore != null && ev.intAwayScore != null && (started || finished);
          const scoreOrTime = hasScore
            ? `<span class="fifa-score">${escapeHtml(ev.intHomeScore)} - ${escapeHtml(ev.intAwayScore)}</span>`
            : `<span class="fifa-time">${start ? escapeHtml(fmtTimeBD(start)) : escapeHtml(ev.strTime || '')}</span>`;
          const statusLabel = finished ? 'FT' : started ? 'LIVE' : 'Upcoming';
          const groupTag = ev.strGroup ? `Group ${ev.strGroup}` : `Round ${ev.intRound || ''}`;
          return `
            <div class="fifa-row">
              <div class="fifa-team home">${homeBadge}<span class="fifa-team-name">${escapeHtml(home)}</span></div>
              <div class="fifa-center">
                ${scoreOrTime}
                <span class="fifa-status${started && !finished ? ' live' : ''}">${escapeHtml(statusLabel)}</span>
                <span class="fifa-group-tag">${escapeHtml(groupTag)}</span>
              </div>
              <div class="fifa-team away">${awayBadge}<span class="fifa-team-name">${escapeHtml(away)}</span></div>
            </div>`;
        })
        .join('');
      return `<div class="fifa-group"><div class="fifa-group-title">${escapeHtml(dateLabel)}</div>${rows}</div>`;
    })
    .join('');

  fifaFullScheduleEl.querySelectorAll('.fifa-row').forEach((el) => {
    el.addEventListener('click', () => enterCategoryFromHome('Fifa'));
  });
}

function renderFifaTabs() {
  const tabs = [
    { key: 'results', label: 'Results', count: fifaBuckets.results.length },
    { key: 'today', label: 'Today', count: fifaBuckets.today.length },
    { key: 'tomorrow', label: 'Tomorrow', count: fifaBuckets.tomorrow.length },
  ];
  fifaTabsEl.innerHTML = tabs
    .map(
      (t) =>
        `<button class="fifa-tab${t.key === fifaActiveTab ? ' active' : ''}" data-tab="${t.key}">${t.label} (${t.count})</button>`
    )
    .join('');
  fifaTabsEl.querySelectorAll('.fifa-tab').forEach((el) => {
    el.addEventListener('click', () => {
      fifaActiveTab = el.dataset.tab;
      renderFifaTabs();
      renderFifaSchedule();
    });
  });
}

function renderFifaSchedule() {
  const events = fifaBuckets[fifaActiveTab] || [];
  if (!events.length) {
    fifaScheduleEl.innerHTML = `<div class="empty-state"><div style="font-size:28px;">⚽</div><div>No matches in this list.</div></div>`;
    return;
  }

  const groups = new Map();
  for (const ev of events) {
    const key = ev.strGroup ? `Group ${ev.strGroup}` : ev.strLeague || 'Matches';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }

  fifaScheduleEl.innerHTML = [...groups.entries()]
    .map(([groupName, matches]) => {
      const rows = matches
        .map((ev) => {
          const { started, finished, start } = matchWindow(ev);
          const home = ev.strHomeTeam || 'Home';
          const away = ev.strAwayTeam || 'Away';
          const homeBadge = ev.strHomeTeamBadge
            ? `<img class="fifa-team-badge" src="${escapeHtml(ev.strHomeTeamBadge)}" />`
            : '<span class="fifa-team-badge-fallback">⚽</span>';
          const awayBadge = ev.strAwayTeamBadge
            ? `<img class="fifa-team-badge" src="${escapeHtml(ev.strAwayTeamBadge)}" />`
            : '<span class="fifa-team-badge-fallback">⚽</span>';
          const hasScore = ev.intHomeScore != null && ev.intAwayScore != null && (started || finished);
          const scoreOrTime = hasScore
            ? `<span class="fifa-score">${escapeHtml(ev.intHomeScore)} - ${escapeHtml(ev.intAwayScore)}</span>`
            : `<span class="fifa-time">${start ? escapeHtml(fmtTimeBD(start)) : escapeHtml(ev.strTime || '')}</span>`;
          const statusLabel = finished ? 'FT' : started ? 'LIVE' : fifaActiveTab === 'tomorrow' ? 'Tomorrow' : fifaActiveTab === 'results' ? 'FT' : 'Today';
          return `
            <div class="fifa-row">
              <div class="fifa-team home">${homeBadge}<span class="fifa-team-name">${escapeHtml(home)}</span></div>
              <div class="fifa-center">
                ${scoreOrTime}
                <span class="fifa-status${started && !finished ? ' live' : ''}">${escapeHtml(statusLabel)}</span>
              </div>
              <div class="fifa-team away">${awayBadge}<span class="fifa-team-name">${escapeHtml(away)}</span></div>
            </div>`;
        })
        .join('');
      return `<div class="fifa-group"><div class="fifa-group-title">${escapeHtml(groupName)}</div>${rows}</div>`;
    })
    .join('');

  fifaScheduleEl.querySelectorAll('.fifa-row').forEach((el) => {
    el.addEventListener('click', () => enterCategoryFromHome('Fifa'));
  });
}

// ---------- Continue watching ----------

function readRecents() {
  try {
    return JSON.parse(localStorage.getItem(RECENTS_KEY)) || [];
  } catch {
    return [];
  }
}

function addRecent(channel) {
  const recents = readRecents().filter((c) => c.url !== channel.url);
  recents.unshift({ name: channel.name, group: channel.group, logo: channel.logo, url: channel.url });
  localStorage.setItem(RECENTS_KEY, JSON.stringify(recents.slice(0, RECENTS_MAX)));
  renderRecents();
}

function renderRecents() {
  const recents = readRecents();
  if (!recents.length) {
    recentsSection.style.display = 'none';
    return;
  }
  recentsSection.style.display = 'block';
  recentsRowEl.innerHTML = recents
    .map((c, i) => {
      const logo = c.logo
        ? `<img class="grid-logo" src="${escapeHtml(c.logo)}" loading="lazy" onerror="this.outerHTML='<div class=\\'grid-logo fallback\\'>${initials(c.name)}</div>'" />`
        : `<div class="grid-logo fallback">${initials(c.name)}</div>`;
      return `
        <div class="channel-card recent-card" data-idx="${i}">
          <div class="grid-thumb">${logo}</div>
          <div class="grid-name">${escapeHtml(c.name)}</div>
          <div class="grid-group">${escapeHtml(c.group)}</div>
        </div>`;
    })
    .join('');

  recentsRowEl.querySelectorAll('.recent-card').forEach((el) => {
    el.addEventListener('click', () => {
      const channel = recents[parseInt(el.dataset.idx, 10)];
      if (channel) playChannel(channel);
    });
  });
}

// ---------- Home: trending categories & popular countries ----------

function renderTrendingCategories() {
  const counts = new Map();
  for (const c of allChannels) {
    for (const cat of c.categories || [c.group]) counts.set(cat, (counts.get(cat) || 0) + 1);
  }
  const cats = [...counts.keys()]
    .filter((g) => g !== 'Undefined' && g !== 'Uncategorized')
    .sort((a, b) => counts.get(b) - counts.get(a))
    .slice(0, 10);

  if (!cats.length) {
    trendingCatSection.style.display = 'none';
    return;
  }

  trendingCatSection.style.display = 'block';
  trendingCatGridEl.innerHTML = cats
    .map(
      (cat) => `
        <div class="trending-cat-card" data-category="${escapeHtml(cat)}">
          <div class="trending-cat-icon">${eventIcon(cat)}</div>
          <div class="trending-cat-name">${escapeHtml(cat)}</div>
          <div class="trending-cat-count">${counts.get(cat)} channels</div>
        </div>`
    )
    .join('');

  trendingCatGridEl.querySelectorAll('.trending-cat-card').forEach((el) => {
    el.addEventListener('click', () => enterCategoryFromHome(el.dataset.category));
  });
}

function renderPopularCountries() {
  const counts = new Map();
  for (const c of allChannels) {
    if (!c.country) continue;
    counts.set(c.country, (counts.get(c.country) || 0) + 1);
  }
  const codes = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a)).slice(0, 10);

  if (!codes.length) {
    popularCountrySection.style.display = 'none';
    return;
  }

  popularCountrySection.style.display = 'block';
  popularCountryGridEl.innerHTML = codes
    .map(
      (code) => `
        <div class="popular-country-card" data-country="${escapeHtml(code)}">
          <div class="popular-country-flag">${flagImg(code, '48x36')}</div>
          <div class="popular-country-name">${escapeHtml(countryName(code))}</div>
          <div class="popular-country-count">${counts.get(code)} channels</div>
        </div>`
    )
    .join('');

  popularCountryGridEl.querySelectorAll('.popular-country-card').forEach((el) => {
    el.addEventListener('click', () => {
      setActiveCountry(el.dataset.country);
      activeCategory = 'All';
      visibleCount = PAGE_SIZE;
      renderCategories();
      renderChannelGrid();
      showView('browse');
    });
  });
}

// ---------- Country dropdown (top menu) ----------

function setActiveCountry(code) {
  activeCountry = code;
  countrySelectFlag.innerHTML = code === 'All' ? '🌍' : code === '__other__' ? '🌐' : flagImg(code, '24x18');
  countrySelectLabel.textContent = code === 'All' ? 'All Countries' : code === '__other__' ? 'Other' : countryName(code);
}

function renderCountryDropdown(filterText = '') {
  const counts = new Map();
  for (const c of allChannels) {
    const key = c.country || '';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const otherCount = counts.get('') || 0;
  const query = filterText.trim().toLowerCase();

  let codes = [...counts.keys()].filter(Boolean).sort((a, b) => counts.get(b) - counts.get(a));
  if (query) codes = codes.filter((code) => countryName(code).toLowerCase().includes(query));

  const allRow =
    !query || 'all countries'.includes(query)
      ? `<div class="country-row" data-country="All"><span class="country-row-flag">🌍</span><span class="country-row-name">All Countries</span><span class="country-row-count">${allChannels.length}</span></div>`
      : '';

  const rows = codes
    .map(
      (code) => `
        <div class="country-row" data-country="${escapeHtml(code)}">
          <span class="country-row-flag">${flagImg(code, '24x18')}</span>
          <span class="country-row-name">${escapeHtml(countryName(code))}</span>
          <span class="country-row-count">${counts.get(code)}</span>
        </div>`
    )
    .join('');

  const otherRow =
    otherCount && (!query || 'other unspecified'.includes(query))
      ? `<div class="country-row" data-country="__other__"><span class="country-row-flag">🌐</span><span class="country-row-name">Other / Unspecified</span><span class="country-row-count">${otherCount}</span></div>`
      : '';

  countryDropdownList.innerHTML = allRow + rows + otherRow;

  countryDropdownList.querySelectorAll('.country-row').forEach((el) => {
    el.addEventListener('click', () => {
      setActiveCountry(el.dataset.country);
      closeCountryDropdown();
      activeCategory = 'All';
      visibleCount = PAGE_SIZE;
      renderCategories();
      renderChannelGrid();
      showView('browse');
    });
  });
}

function toggleCountryDropdown() {
  const isOpen = countryDropdown.style.display === 'block';
  countryDropdown.style.display = isOpen ? 'none' : 'block';
  if (!isOpen) {
    countrySearchInput.value = '';
    renderCountryDropdown();
    countrySearchInput.focus();
  }
}

function closeCountryDropdown() {
  countryDropdown.style.display = 'none';
}

countrySelectBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleCountryDropdown();
});

countrySearchInput.addEventListener('input', () => renderCountryDropdown(countrySearchInput.value));

document.addEventListener('click', (e) => {
  if (!e.target.closest('.country-select-wrap')) closeCountryDropdown();
});

const searchWrap = () => searchInput.value.trim().toLowerCase();

searchInput.addEventListener('input', () => {
  visibleCount = PAGE_SIZE;
  const query = searchWrap();
  if (query) {
    renderSearchResults(query);
  } else {
    hideSearchResults();
  }
  if (browseView.style.display !== 'none') renderChannelGrid();
});

searchInput.addEventListener('focus', () => {
  if (searchWrap()) renderSearchResults(searchWrap());
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrap')) hideSearchResults();
});

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== searchInput) {
    e.preventDefault();
    searchInput.focus();
  } else if (e.key === 'Escape') {
    hideSearchResults();
    searchInput.blur();
  }
});

function renderSearchResults(query) {
  const matches = allChannels.filter((c) => c.name.toLowerCase().includes(query)).slice(0, 8);
  if (!matches.length) {
    searchResultsEl.innerHTML = `<div class="search-empty">No channels found</div>`;
  } else {
    searchResultsEl.innerHTML = matches
      .map((c, i) => {
        const logo = c.logo
          ? `<img class="search-logo" src="${escapeHtml(c.logo)}" loading="lazy" onerror="this.style.display='none'" />`
          : '';
        return `<div class="search-result-item" data-idx="${i}">${logo}<div><div class="search-result-name">${escapeHtml(c.name)}</div><div class="search-result-group">${escapeHtml(c.group)}</div></div></div>`;
      })
      .join('');
    searchResultsEl.querySelectorAll('.search-result-item').forEach((el) => {
      el.addEventListener('click', () => {
        const channel = matches[parseInt(el.dataset.idx, 10)];
        if (channel) {
          hideSearchResults();
          searchInput.value = '';
          playChannel(channel);
        }
      });
    });
  }
  searchResultsEl.style.display = 'block';
}

function hideSearchResults() {
  searchResultsEl.style.display = 'none';
}

let scrollScheduled = false;
channelGridEl.addEventListener('scroll', () => {
  if (scrollScheduled) return;
  scrollScheduled = true;
  requestAnimationFrame(() => {
    scrollScheduled = false;
    const nearBottom = channelGridEl.scrollTop + channelGridEl.clientHeight >= channelGridEl.scrollHeight - 300;
    if (nearBottom && visibleCount < lastFiltered.length) {
      visibleCount += PAGE_SIZE;
      appendChannelCards();
    }
  });
});

function countryFilteredChannels() {
  if (activeCountry === 'All') return allChannels;
  if (activeCountry === '__other__') return allChannels.filter((c) => !c.country);
  return allChannels.filter((c) => c.country === activeCountry);
}

function renderCategories() {
  const scoped = countryFilteredChannels();
  const counts = new Map();
  for (const c of scoped) {
    for (const cat of c.categories || [c.group]) counts.set(cat, (counts.get(cat) || 0) + 1);
  }
  const groups = [...counts.keys()].sort((a, b) => a.localeCompare(b));
  const ordered = ['All', ...(groups.includes('Fifa') ? ['Fifa', ...groups.filter((g) => g !== 'Fifa')] : groups)];

  categoriesEl.innerHTML = ordered
    .map((g) => {
      const label = g === 'All' ? `All (${scoped.length})` : `${g} (${counts.get(g)})`;
      return `<div class="category-chip${g === activeCategory ? ' active' : ''}" data-group="${escapeHtml(g)}">${escapeHtml(label)}</div>`;
    })
    .join('');

  categoriesEl.querySelectorAll('.category-chip').forEach((el) => {
    el.addEventListener('click', () => {
      activeCategory = el.dataset.group;
      visibleCount = PAGE_SIZE;
      renderCategories();
      renderChannelGrid();
    });
  });
}

function channelCardHtml(c, i) {
  const logo = c.logo
    ? `<img class="grid-logo" src="${escapeHtml(c.logo)}" loading="lazy" onerror="this.outerHTML='<div class=\\'grid-logo fallback\\'>${initials(c.name)}</div>'" />`
    : `<div class="grid-logo fallback">${initials(c.name)}</div>`;
  return `
    <div class="channel-card" data-idx="${i}">
      ${logo ? `<div class="grid-thumb">${logo}<span class="grid-live-dot">LIVE</span></div>` : ''}
      <div class="grid-name">${escapeHtml(c.name)}</div>
      <div class="grid-group">${escapeHtml(c.group)}</div>
    </div>`;
}

function bindChannelCard(el) {
  el.addEventListener('click', () => {
    const channel = lastFiltered[parseInt(el.dataset.idx, 10)];
    if (channel) playChannel(channel);
  });
}

function renderChannelGrid() {
  const query = searchWrap();
  const scoped = countryFilteredChannels();
  const filtered = scoped.filter((c) => {
    const inCategory = activeCategory === 'All' || (c.categories || [c.group]).includes(activeCategory);
    const matchesQuery = !query || c.name.toLowerCase().includes(query);
    return inCategory && matchesQuery;
  });
  lastFiltered = filtered;

  if (!filtered.length) {
    channelGridEl.innerHTML = `<div class="empty-state"><div style="font-size:32px;">🔍</div><div>No channels match your filter.</div></div>`;
    return;
  }

  const slice = filtered.slice(0, visibleCount);
  channelGridEl.innerHTML = slice.map(channelCardHtml).join('');
  channelGridEl.querySelectorAll('.channel-card').forEach(bindChannelCard);
  renderListEndHint(filtered.length, slice.length);
}

function appendChannelCards() {
  const hint = channelGridEl.querySelector('.list-end-hint');
  if (hint) hint.remove();

  const prevCount = channelGridEl.querySelectorAll('.channel-card').length;
  const slice = lastFiltered.slice(prevCount, visibleCount);
  const frag = document.createElement('div');
  frag.innerHTML = slice.map((c, i) => channelCardHtml(c, prevCount + i)).join('');
  [...frag.children].forEach((el) => {
    bindChannelCard(el);
    channelGridEl.appendChild(el);
  });
  renderListEndHint(lastFiltered.length, prevCount + slice.length);
}

function renderListEndHint(total, shown) {
  if (shown < total) {
    channelGridEl.insertAdjacentHTML('beforeend', `<div class="list-end-hint">Scroll for more (${total - shown} left)</div>`);
  }
}

function initials(name) {
  return escapeHtml(
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0] || '')
      .join('')
      .toUpperCase()
  );
}

function escapeHtml(str) {
  // Escapes &,<,> AND quotes — values from third-party M3U playlists (logo
  // URLs, group titles, channel names) get interpolated into HTML attributes
  // like src="..." / data-category="...", so unescaped quotes would break out
  // of the attribute and allow markup injection.
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------- Player ----------

function findChannelNavList() {
  return lastFiltered && lastFiltered.length ? lastFiltered : allChannels;
}

function playChannel(channel, isAuto = false) {
  currentChannel = channel;
  retryCount = 0;
  if (!isAuto) autoFailoverAttempts = 0; // a manual pick resets the failover chain
  clearTimeout(retryTimer);
  clearTimeout(failoverTimer);
  clearTimeout(watchdogTimer);
  clearTimeout(slowNoticeTimer);

  npName.textContent = channel.name;
  npGroup.textContent = channel.group;
  setNetStatus('');
  showView('player');
  addRecent(channel);

  startViewerWatch(channel.url);
  startStream(channel.url);
  armWatchdog(channel.url);
}

// Single funnel for every "this channel won't play" path. Auto-advances to the
// next channel in the current list so the user lands on a working stream
// instead of having to manually skip past dead ones (the FIFA list especially
// has many offline/overloaded servers at any given moment).
function failChannel(message) {
  streamActive = false;
  clearTimeout(retryTimer);
  clearTimeout(failoverTimer);
  disarmWatchdog();
  destroyPlayers(); // stop the dead player firing more error events
  showSpinner(false);

  const list = findChannelNavList();
  const canFailover = currentChannel && list.length > 1 && autoFailoverAttempts < MAX_AUTO_FAILOVER;
  if (canFailover) {
    autoFailoverAttempts += 1;
    setNetStatus(`${message} — finding a working channel (${autoFailoverAttempts})…`, true);
    failoverTimer = setTimeout(() => navigateChannel(1, true), 900);
  } else {
    autoFailoverAttempts = 0;
    setNetStatus(`${message}. Nearby channels also seem offline right now — try a different category.`, true);
  }
}

// Independent of hls.js's own internal retries — guarantees the user sees a
// clear result within ~16s instead of waiting through several stacked
// rounds of internal + our own retry backoff on a genuinely dead stream.
function armWatchdog(url) {
  clearTimeout(watchdogTimer);
  clearTimeout(slowNoticeTimer);
  slowNoticeTimer = setTimeout(() => {
    if (!video.paused && video.readyState >= 3) return;
    setNetStatus('Still connecting... this one may be slow', true);
  }, 6000);
  watchdogTimer = setTimeout(() => {
    if (!video.paused && video.readyState >= 3) return;
    giveUpOnChannel(url);
  }, 12000);
}

function disarmWatchdog() {
  clearTimeout(watchdogTimer);
  clearTimeout(slowNoticeTimer);
}

function giveUpOnChannel() {
  stopStream();
  failChannel("This channel isn't responding");
}

function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

function startViewerWatch(url) {
  stopViewerWatch();
  if (!viewersAvailable()) {
    viewerCountEl.style.display = 'none';
    return;
  }
  currentChannelKey = hashSeed(url);
  joinChannel(currentChannelKey);
  viewerCountEl.style.display = 'inline-flex';
  unwatchViewers = watchViewerCount(currentChannelKey, (count) => {
    viewerCountNum.textContent = String(count);
  });
}

function stopViewerWatch() {
  leaveChannel();
  if (unwatchViewers) {
    unwatchViewers();
    unwatchViewers = null;
  }
  currentChannelKey = null;
}

function destroyPlayers() {
  if (hls) {
    hls.destroy();
    hls = null;
  }
  if (tsPlayer) {
    try {
      tsPlayer.destroy();
    } catch {
      // ignore
    }
    tsPlayer = null;
  }
}

function startStream(url, { viaProxy = false } = {}) {
  destroyPlayers();
  streamActive = true;
  showSpinner(true);

  // http:// streams are hard-blocked by the browser as mixed content on an
  // https page, before hls.js even gets a chance — route straight through the
  // proxy (it fetches server-side and re-serves over our own origin).
  if (!viaProxy && location.protocol === 'https:' && url.startsWith('http://')) {
    startStream(url, { viaProxy: true });
    return;
  }

  // Raw MPEG-TS streams (common in FIFA/BDIX panel lists) aren't HLS — hls.js
  // can't play them. Route .ts URLs through mpegts.js (lazy-loaded).
  if (isRawTsUrl(url)) {
    startMpegtsStream(url, viaProxy);
    return;
  }

  if (Hls.isSupported()) {
    hls = new Hls({
      enableWorker: true,
      // lowLatencyMode is meant for LL-HLS; on ordinary IPTV it makes hls
      // aggressively chase the live edge, overrun the buffer, and stall
      // constantly (spinner flicker). Turning it off plays much smoother.
      // Keep liveSyncDurationCount at the default 3 — going deeper breaks
      // streams whose DVR window is only a few segments long.
      lowLatencyMode: false,
      abrEwmaDefaultEstimate: 1000000,
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      backBufferLength: 30,
      liveSyncDurationCount: 3,
      liveDurationInfinity: true,
      // Don't waste bandwidth/CPU decoding a higher resolution than the
      // player is actually displayed at.
      capLevelToPlayerSize: true,
      // Fail fast: a dead/unreachable stream should surface clearly within a
      // few seconds rather than hls.js silently retrying for 30-60s+ before
      // we even get a fatal error to react to.
      fragLoadingMaxRetry: 2,
      fragLoadingTimeOut: 8000,
      manifestLoadingMaxRetry: 2,
      manifestLoadingTimeOut: 6000,
      levelLoadingMaxRetry: 2,
      levelLoadingTimeOut: 6000,
    });

    hls.loadSource(viaProxy ? proxiedManifestUrl(url) : url);
    hls.attachMedia(video);
    startNetQualityMonitor();

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      populateQualityLevels(hls.levels);
      showSpinner(false);
      disarmWatchdog();
      restoreVolumePref();
      video.play().catch(() => {});
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
      const level = hls.levels[data.level];
      if (level) {
        qualityBadge.textContent = formatQualityLabel(level, qualitySelect.value === '-1');
      }
    });

    hls.on(Hls.Events.ERROR, (event, data) => {
      if (!data.fatal) return;
      // First failure on a direct attempt: silently retry once through our
      // proxy before falling into the normal retry/failover flow — this
      // transparently recovers CORS-blocked and mixed-content streams.
      if (!viaProxy && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        startStream(url, { viaProxy: true });
        return;
      }
      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          setNetStatus('Network issue, reconnecting...', true);
          scheduleRetry(url, viaProxy);
          break;
        case Hls.ErrorTypes.MEDIA_ERROR:
          setNetStatus('Recovering playback...', true);
          hls.recoverMediaError();
          break;
        default:
          setNetStatus('Stream error, retrying...', true);
          scheduleRetry(url, viaProxy);
      }
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = viaProxy ? proxiedManifestUrl(url) : url;
  } else {
    video.src = url;
    video.play().catch(() => {});
    showSpinner(false);
    disarmWatchdog();
    restoreVolumePref();
  }
}

function stopStream() {
  streamActive = false;
  clearTimeout(retryTimer);
  clearTimeout(failoverTimer);
  disarmWatchdog();
  stopNetQualityMonitor();
  destroyPlayers();
  video.removeAttribute('src');
  video.load();
}

// A bare MPEG-TS stream (…/123.ts, optionally with a query string) rather than
// an HLS .m3u8 manifest. hls.js can't play these; mpegts.js can.
function isRawTsUrl(url) {
  return /\.ts(\?.*)?$/i.test(url);
}

async function startMpegtsStream(url, viaProxy = false) {
  try {
    const mpegtsMod = await import('mpegts.js');
    const mpegts = mpegtsMod.default || mpegtsMod;
    if (!mpegts.isSupported()) {
      failChannel("This stream format isn't supported by your browser");
      return;
    }
    // A newer channel may have been selected while the module loaded.
    if (currentChannel && currentChannel.url !== url) return;

    tsPlayer = mpegts.createPlayer(
      { type: 'mpegts', isLive: true, url: viaProxy ? proxiedSegmentUrl(url) : url },
      // liveBufferLatencyChasing off: chasing the live edge causes constant
      // stalls on slow IPTV feeds. A small stable buffer plays much smoother.
      { enableWorker: true, liveBufferLatencyChasing: false, lazyLoad: false, stashInitialSize: 1024 * 256 }
    );
    tsPlayer.attachMediaElement(video);
    tsPlayer.on(mpegts.Events.ERROR, () => {
      if (!viaProxy) {
        startMpegtsStream(url, true); // retry once through the proxy before giving up
        return;
      }
      failChannel("This channel isn't responding");
    });
    tsPlayer.load();
    startNetQualityMonitor();
    video.play().catch(() => {});
  } catch (err) {
    failChannel('Could not start this stream');
  }
}

function scheduleRetry(url, viaProxy = false) {
  if (retryCount >= 2) {
    failChannel("This channel isn't responding");
    return;
  }
  retryCount += 1;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => startStream(url, { viaProxy }), 1500 * retryCount);
}

function showSpinner(show) {
  spinner.style.display = show ? 'block' : 'none';
}

// Some streams don't report a usable height (audio-only renditions, or
// servers that omit RESOLUTION in the manifest) — fall back to bitrate or a
// plain label instead of showing a meaningless "0p".
function formatQualityLabel(level, isAuto) {
  const label = level.height > 0 ? `${level.height}p` : level.bitrate ? `${Math.round(level.bitrate / 1000)}kbps` : 'LIVE';
  return isAuto ? `AUTO ${label}` : label;
}

function populateQualityLevels(levels) {
  qualitySelect.innerHTML =
    `<option value="-1">Auto</option>` +
    levels.map((lvl, i) => `<option value="${i}">${formatQualityLabel(lvl, false)}</option>`).join('');
  qualitySelect.value = '-1';
  qualityBadge.textContent = 'AUTO';
}

qualitySelect.addEventListener('change', () => {
  if (!hls) return;
  const val = parseInt(qualitySelect.value, 10);
  hls.currentLevel = val;
  qualityBadge.textContent = val === -1 ? 'AUTO' : formatQualityLabel(hls.levels[val], false);
});

playBtn.addEventListener('click', () => {
  if (video.paused) video.play().catch(() => {});
  else video.pause();
});

video.addEventListener('play', () => (playBtn.textContent = '⏸'));
video.addEventListener('pause', () => (playBtn.textContent = '▶'));

// Registered ONCE (video element is persistent) instead of inside startStream,
// which previously leaked a new listener per channel switch.
// `streamActive` guard: after a give-up/stop, video.load() can fire a stale
// 'waiting' that must NOT re-show the spinner under the error message.
video.addEventListener('waiting', () => {
  if (streamActive) showSpinner(true);
});
video.addEventListener('playing', () => {
  showSpinner(false);
  setNetStatus('');
  disarmWatchdog();
  autoFailoverAttempts = 0; // reached actual playback — failover chain done
});
video.addEventListener('loadedmetadata', () => {
  // Metadata available = the stream works (even if autoplay is paused).
  // Finalize load (native-HLS/Safari has no MANIFEST_PARSED) and end failover.
  showSpinner(false);
  disarmWatchdog();
  autoFailoverAttempts = 0;
  restoreVolumePref();
  video.play().catch(() => {});
});

muteBtn.addEventListener('click', () => toggleMute());

function toggleMute() {
  video.muted = !video.muted;
  muteBtn.textContent = video.muted ? '🔇' : '🔊';
}

function saveVolumePref() {
  try {
    localStorage.setItem(VOLUME_KEY, JSON.stringify({ volume: video.volume, muted: video.muted }));
  } catch {
    // ignore quota errors
  }
}

function restoreVolumePref() {
  try {
    const saved = JSON.parse(localStorage.getItem(VOLUME_KEY));
    if (saved && typeof saved.volume === 'number') {
      video.volume = saved.volume;
      video.muted = Boolean(saved.muted);
      volumeSlider.value = String(saved.volume);
      muteBtn.textContent = video.muted ? '🔇' : '🔊';
    }
  } catch {
    // ignore corrupt prefs
  }
}

volumeSlider.addEventListener('input', () => {
  video.volume = parseFloat(volumeSlider.value);
  video.muted = video.volume === 0;
  muteBtn.textContent = video.muted ? '🔇' : '🔊';
  saveVolumePref();
});

video.addEventListener('volumechange', saveVolumePref);

pipBtn.addEventListener('click', async () => {
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else {
      await video.requestPictureInPicture();
    }
  } catch (err) {
    setNetStatus('Picture-in-Picture not available', true);
  }
});

fullscreenBtn.addEventListener('click', () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    playerWrap.requestFullscreen().catch(() => {});
  }
});

video.addEventListener('dblclick', () => fullscreenBtn.click());

// Single click toggles play/pause (ignored on the same click that ends a drag/double-click via dblclick's own handling)
video.addEventListener('click', () => playBtn.click());

shortcutsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  shortcutsPanel.style.display = shortcutsPanel.style.display === 'block' ? 'none' : 'block';
});

document.addEventListener('click', (e) => {
  if (shortcutsPanel.style.display === 'block' && !e.target.closest('#shortcuts-panel') && !e.target.closest('#shortcuts-btn')) {
    shortcutsPanel.style.display = 'none';
  }
});

// ---------- Next/previous channel ----------

function navigateChannel(direction, isAuto = false) {
  const list = findChannelNavList();
  if (!currentChannel || !list.length) return;
  let idx = list.findIndex((c) => c.url === currentChannel.url);
  if (idx === -1) idx = 0;
  const nextIdx = (idx + direction + list.length) % list.length;
  playChannel(list[nextIdx], isAuto);
}

// Manual next/prev — reset the auto-failover chain (user is deliberately moving)
prevChannelBtn.addEventListener('click', () => {
  autoFailoverAttempts = 0;
  navigateChannel(-1);
});
nextChannelBtn.addEventListener('click', () => {
  autoFailoverAttempts = 0;
  navigateChannel(1);
});

// ---------- Keyboard shortcuts (only while the player view is open) ----------

document.addEventListener('keydown', (e) => {
  if (playerView.style.display === 'none') return;
  if (document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

  switch (e.key.toLowerCase()) {
    case ' ':
      e.preventDefault();
      playBtn.click();
      break;
    case 'm':
      toggleMute();
      break;
    case 'f':
      fullscreenBtn.click();
      break;
    case 'p':
      pipBtn.click();
      break;
    case 'n':
      navigateChannel(1);
      break;
    case 'b':
      navigateChannel(-1);
      break;
    case 'escape':
      shortcutsPanel.style.display = 'none';
      break;
    case 'arrowup':
      e.preventDefault();
      video.volume = Math.min(1, video.volume + 0.1);
      volumeSlider.value = String(video.volume);
      video.muted = false;
      muteBtn.textContent = '🔊';
      saveVolumePref();
      break;
    case 'arrowdown':
      e.preventDefault();
      video.volume = Math.max(0, video.volume - 0.1);
      volumeSlider.value = String(video.volume);
      saveVolumePref();
      break;
  }
});

// ---------- Pause playback when the tab is hidden (saves bandwidth/CPU) ----------

let wasPlayingBeforeHidden = false;
document.addEventListener('visibilitychange', () => {
  if (playerView.style.display === 'none') return;
  if (document.hidden) {
    wasPlayingBeforeHidden = !video.paused;
    video.pause();
  } else if (wasPlayingBeforeHidden) {
    video.play().catch(() => {});
  }
});

// ---------- Live network quality indicator (estimated bandwidth from hls.js) ----------

function startNetQualityMonitor() {
  clearInterval(netQualityTimer);
  netQualityTimer = setInterval(() => {
    if (!hls || !hls.bandwidthEstimate) {
      netQualityBadge.style.display = 'none';
      return;
    }
    const mbps = hls.bandwidthEstimate / 1_000_000;
    let label = '📶 Good';
    let cls = 'good';
    if (mbps < 1.5) {
      label = '📶 Poor';
      cls = 'poor';
    } else if (mbps < 4) {
      label = '📶 Fair';
      cls = 'fair';
    }
    netQualityBadge.textContent = `${label} (${mbps.toFixed(1)} Mbps)`;
    netQualityBadge.className = `net-quality-badge ${cls}`;
    netQualityBadge.style.display = 'inline-flex';
  }, 4000);
}

function stopNetQualityMonitor() {
  clearInterval(netQualityTimer);
  netQualityBadge.style.display = 'none';
}

window.addEventListener('beforeunload', stopViewerWatch);
