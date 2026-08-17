import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const mainSource = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const htmlSource = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function extractFunction(name) {
  const candidates = [`async function ${name}`, `function ${name}`];
  const start = candidates
    .map((candidate) => mainSource.indexOf(candidate))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  assert.notEqual(start, undefined, `Cannot find function ${name}`);

  const brace = mainSource.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < mainSource.length; i++) {
    if (mainSource[i] === '{') depth++;
    if (mainSource[i] === '}') depth--;
    if (depth === 0) return mainSource.slice(start, i + 1);
  }
  throw new Error(`Unclosed function ${name}`);
}

class FakeClassList {
  constructor(initial = []) {
    this.values = new Set(initial);
  }

  add(...names) {
    for (const name of names) this.values.add(name);
  }

  remove(...names) {
    for (const name of names) this.values.delete(name);
  }

  contains(name) {
    return this.values.has(name);
  }

  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : Boolean(force);
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }
}

class FakeElement {
  constructor({ classes = [], dataset = {} } = {}) {
    this.classList = new FakeClassList(classes);
    this.dataset = dataset;
    this.attributes = new Map();
    this.textContent = '';
    this.disabled = false;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  focus() {}
}

const functionNames = [
  'openFeaturedVideo',
  'showToyNotice',
  'normalizePianoOctaveStart',
  'effectivePianoOctaveStart',
  'octaveControlsEnabled',
  'applyPerformanceSettings',
  'replacePerformanceSettings',
  'resetPerformanceSettingsToDefaults',
  'markToyCloudUnavailable',
  'readCloudPerformanceSettings',
  'renderPerformanceSettings',
  'renderToyCloudState',
  'detectToyEnvironment',
  'createCoinUnlockError',
  'getCoinUnlockErrorId',
  'normalizeVideoResponseItem',
  'isSuccessfulVideoBatchResponse',
  'findSuccessfulVideoItem',
  'resolveFeaturedVideoAid',
  'refreshCoinUnlock',
  'detectToyCloudSupport',
  'initializeToyCloudState',
  'persistSeenState',
  'markSettingsSeen',
  'markSfxNewSeen',
  'markAllSfxNewSeen',
  'requireToyUnlockContext',
  'verifyCoinUnlockForTrigger',
  'openUnlockConfirm',
  'closeUnlockConfirm',
  'setUnlockConfirmPending',
  'confirmUnlockFromVideo',
  'renderHajimiCharacterControl',
  'getAudioBeatPosition',
  'alignHajimiAnimationToBeat',
  'renderHajimiAnimationFrame',
  'applyHajimiAnimationVisibility',
  'ensureHajimiAnimationLoaded',
  'setHajimiSkin',
  'selectSfxOption',
  'handleSkinOptionClick',
  'openSettings',
  'closeSettings',
  'handleAuthorHomeClick',
  'handleSfxOptionClick',
  'handlePerformanceSettingClick',
  'flushPianoOctaveCloudWrite',
  'queuePianoOctaveCloudWrite',
  'shiftPianoOctave',
];
const extractedFunctions = functionNames.map(extractFunction).join('\n');

function makeToy({
  cloud = {},
  support = true,
  aid = 123456789,
  coinCount = 0,
  authorVideosResponse = null,
  videoActionsResponse = null,
  authorVideosError = null,
  videoActionsError = null,
  getError = null,
  setError = null,
  setHandler = null,
  navigateError = null,
  navigateHandler = null,
} = {}) {
  const log = [];
  const storage = { ...cloud };
  let currentCoinCount = coinCount;
  const toy = {
    async isSupport(ability) {
      log.push(`support:${ability}`);
      if (typeof support === 'function') return support(ability);
      if (support && typeof support === 'object') return support[ability] !== false;
      return support;
    },
    async getCloudStorage(keys) {
      log.push(`get:${keys.join(',')}`);
      if (getError) throw getError;
      return Object.fromEntries(
        keys.filter((key) => key in storage).map((key) => [key, storage[key]])
      );
    },
    async setCloudStorage(items) {
      const keys = Object.keys(items).sort().join(',');
      log.push(`set:${keys}`);
      if (setError) throw setError;
      if (setHandler) await setHandler(items);
      Object.assign(storage, items);
    },
    async navigate(request) {
      log.push(`navigate:${request.type}:${request.id}`);
      if (navigateError) throw navigateError;
      if (navigateHandler) await navigateHandler(request);
    },
    async getAuthorVideos(request) {
      log.push(`authorVideos:${request.videos[0].bvid}`);
      if (authorVideosError) throw authorVideosError;
      return authorVideosResponse ?? {
        status: 'ok',
        items: [{ status: 'ok', aid, bvid: request.videos[0].bvid }],
      };
    },
    async getVideoUserActions(request) {
      log.push(`videoActions:${request.aids[0]}`);
      if (videoActionsError) throw videoActionsError;
      return videoActionsResponse ?? {
        status: 'ok',
        items: [{ status: 'ok', aid: request.aids[0], coinCount: currentCoinCount }],
      };
    },
  };
  return {
    toy,
    log,
    storage,
    setCoinCount(value) {
      currentCoinCount = value;
    },
  };
}

function makeHarness(toy) {
  const options = [
    new FakeElement({ classes: ['sfx-option'], dataset: { sfx: 'dagou' } }),
    new FakeElement({ classes: ['sfx-option', 'is-locked'], dataset: { sfx: 'dingdong' } }),
    new FakeElement({
      classes: ['sfx-option', 'is-active'],
      dataset: { sfx: 'hajimi' },
    }),
  ];
  const hajimiSkinSwitcher = new FakeElement({
    classes: ['skin-switcher', 'is-open'],
  });
  const hajimiSkinClassic = new FakeElement({
    classes: ['skin-option', 'is-active'],
    dataset: { skin: 'classic' },
  });
  const hajimiSkinEmperor = new FakeElement({
    classes: ['skin-option', 'is-locked'],
    dataset: { skin: 'emperor' },
  });
  const hajimiSkinEmperorHint = new FakeElement();
  hajimiSkinEmperorHint.textContent = '投币开发视频解锁';
  const dogCloseImage = new FakeElement();
  dogCloseImage.src = 'Image/maodie_close_mouth.png';
  dogCloseImage.alt = '哈基米';
  const dogOpenImage = new FakeElement();
  dogOpenImage.src = 'Image/maodie_open_mouth.png';
  const dogAnimationCanvas = new FakeElement();
  const dogAnimationAtlas = new FakeElement();
  const dogAnimationDraws = [];
  const dogAnimation2d = {
    clearRect() {},
    drawImage(...drawArguments) {
      dogAnimationDraws.push(drawArguments);
    },
  };
  const hajimiOptionImage = new FakeElement();
  hajimiOptionImage.src = 'Image/maodie_close_mouth.png';
  const dogInner = new FakeElement({ classes: ['is-hajimi'] });
  const notices = [];
  const performanceButtons = [
    new FakeElement({ dataset: { setting: 'pianoMode' } }),
    new FakeElement({ dataset: { setting: 'octaveSwitching' } }),
    new FakeElement({ dataset: { setting: 'rhythmSnap' } }),
    new FakeElement({ dataset: { setting: 'showGrid' } }),
  ];
  const muteLog = [];
  const externalNavigationLog = [];
  const unlockConfirmOverlay = new FakeElement();
  const unlockConfirmTitle = new FakeElement();
  const unlockConfirmMessage = new FakeElement();
  const unlockConfirmCancel = new FakeElement();
  const unlockConfirmSubmit = new FakeElement();
  const context = vm.createContext({
    console: { warn() {} },
    window: {
      toy,
      location: {
        assign(url) {
          externalNavigationLog.push(url);
        },
      },
    },
    setTimeout: (callback) => {
      if (typeof callback === 'function') callback();
      return 1;
    },
    clearTimeout() {},
    TOY_CLOUD_KEYS: {
      settingsSeen: 'dagou_settings_seen_v1',
      dingdongNewSeen: 'dagou_dingdong_new_seen_v1',
      hajimiNewSeen: 'dagou_hajimi_new_seen_v1',
      pianoMode: 'dagou_piano_mode_v1',
      octaveSwitching: 'dagou_octave_switching_v1',
      pianoOctaveStart: 'dagou_piano_octave_start_v1',
      rhythmSnap: 'dagou_rhythm_snap_v1',
      showGrid: 'dagou_show_grid_v1',
    },
    TOY_CLOUD_KEY_LIST: [
      'dagou_settings_seen_v1',
      'dagou_dingdong_new_seen_v1',
      'dagou_hajimi_new_seen_v1',
      'dagou_piano_mode_v1',
      'dagou_octave_switching_v1',
      'dagou_piano_octave_start_v1',
      'dagou_rhythm_snap_v1',
      'dagou_show_grid_v1',
    ],
    TOY_REQUIRED_ABILITIES: [
      'getAuthorVideos',
      'getVideoUserActions',
      'navigate',
    ],
    TOY_CLOUD_ABILITIES: ['getCloudStorage', 'setCloudStorage'],
    VIDEO_UNLOCK_ITEM_IDS: new Set(['dingdong', 'hajimi']),
    LOCKED_SFX_IDS: new Set(['dingdong']),
    SFX_SAMPLE_SETS: Object.freeze({
      dagou: Object.freeze({ da: 'da', gou: 'gou', jiao: 'jiao' }),
      hajimi: Object.freeze({ da: 'ha', gou: 'ji', jiao: 'mi' }),
      dingdong: Object.freeze({
        da: 'dingdongji_ding',
        gou: 'dingdongji_dong',
        jiao: 'dingdongji_ji',
      }),
    }),
    CHARACTER_IMAGE_SETS: Object.freeze({
      dagou: Object.freeze({
        close: 'Image/dagou_close_mouth.png',
        open: 'Image/dagou_open_mouth.png',
        alt: '大狗',
      }),
      dingdong: Object.freeze({
        close: 'Image/dingdongji_close_mouth.png',
        open: 'Image/dingdongji_open_mouth.png',
        alt: '叮咚鸡',
      }),
      hajimi: Object.freeze({
        close: 'Image/maodie_close_mouth.png',
        open: 'Image/maodie_open_mouth.png',
        alt: '哈基米',
      }),
    }),
    HAJIMI_ATLAS_URL: 'Image/donghaidihuang_atlas.webp?v=20260721-beat-synced',
    HAJIMI_STATIC_ICON_URL: 'Image/maodie_close_mouth.png',
    HAJIMI_ANIMATION_ICON_URL: 'Image/donghaidihuang_icon.webp',
    HAJIMI_ANIMATION_BEATS: 9,
    HAJIMI_FRAMES_PER_BEAT: 12,
    HAJIMI_ATLAS_COLUMNS: 12,
    HAJIMI_ATLAS_FRAME_WIDTH: 360,
    HAJIMI_ATLAS_FRAME_HEIGHT: 514,
    HAJIMI_ANIMATION_FRAME_COUNT: 108,
    selectedSfxId: 'hajimi',
    hajimiAnimationEnabled: false,
    hajimiAnimationReady: false,
    hajimiAnimationRequested: false,
    hajimiAnimationFrame: -1,
    hajimiAnimationEpochBeat: 0,
    SPB: 60 / 128,
    started: false,
    ctx: null,
    startTime: 0,
    PIANO_OCTAVE_MIN: 3,
    PIANO_OCTAVE_MAX: 6,
    PIANO_DEFAULT_OCTAVE_START: 4,
    DEFAULT_PERFORMANCE_SETTINGS: Object.freeze({
      pianoMode: false,
      octaveSwitching: false,
      pianoOctaveStart: 4,
      rhythmSnap: true,
      showGrid: false,
    }),
    PERFORMANCE_SETTING_KEYS: Object.freeze({
      pianoMode: 'dagou_piano_mode_v1',
      octaveSwitching: 'dagou_octave_switching_v1',
      rhythmSnap: 'dagou_rhythm_snap_v1',
      showGrid: 'dagou_show_grid_v1',
    }),
    performanceSettings: {
      pianoMode: false,
      octaveSwitching: false,
      pianoOctaveStart: 4,
      rhythmSnap: true,
      showGrid: false,
    },
    performanceSettingsSaving: false,
    pendingPianoOctaveCloudValue: null,
    pianoOctaveCloudWriteRunning: false,
    performanceSettingButtons: performanceButtons,
    octaveSwitchingSetting: new FakeElement(),
    performanceSettingsStatus: new FakeElement(),
    zones: [{}],
    clearQueuedPerformanceInput() {},
    settleActivePerformanceInput() {},
    renderKeyGrid() {},
    renderOctaveControls() {},
    buildGrid() {},
    FEATURED_BVID: 'BV1kNKU6REBg',
    FEATURED_VIDEO_URL: 'https://www.bilibili.com/video/BV1kNKU6REBg/',
    sfxOptions: options,
    hajimiOptionImage,
    hajimiSkinSwitcher,
    hajimiSkinOptions: [hajimiSkinClassic, hajimiSkinEmperor],
    hajimiSkinClassic,
    hajimiSkinEmperor,
    hajimiSkinEmperorHint,
    dogCloseImage,
    dogOpenImage,
    dogAnimationCanvas,
    dogAnimationAtlas,
    dogAnimation2d,
    dogInner,
    topControls: new FakeElement(),
    updateDot: new FakeElement(),
    toyNotice: new FakeElement(),
    videoCard: new FakeElement(),
    settingsOverlay: new FakeElement(),
    settingsButton: new FakeElement(),
    settingsClose: new FakeElement(),
    unlockConfirmOverlay,
    unlockConfirmTitle,
    unlockConfirmMessage,
    unlockConfirmCancel,
    unlockConfirmSubmit,
    settingsOpen: false,
    unlockConfirmOpen: false,
    unlockConfirmTrigger: null,
    openCreatorSpace() {},
    videoNavigationPending: false,
    featuredVideoAid: null,
    coinUnlockCheckPromise: null,
    toyNoticeTimer: 0,
    toyCloudState: {
      toy: null,
      initialized: false,
      environmentAvailable: false,
      cloudReadable: false,
      sfxUnlocked: false,
      settingsSeen: false,
      newSeen: { dingdong: false, hajimi: false },
      locallyChanged: { settingsSeen: false, dingdong: false, hajimi: false },
    },
    toyStateReady: null,
    setNavigationMute(value) {
      muteLog.push(value);
    },
  });
  vm.runInContext(`'use strict';\n${extractedFunctions}`, context);

  const originalNotice = context.showToyNotice;
  context.showToyNotice = (message, isError = false) => {
    notices.push({ message, isError });
    originalNotice(message, isError);
  };

  return {
    context,
    options,
    dogCloseImage,
    dogOpenImage,
    dogAnimationCanvas,
    dogAnimationAtlas,
    dogAnimationDraws,
    hajimiOptionImage,
    hajimiSkinSwitcher,
    hajimiSkinClassic,
    hajimiSkinEmperor,
    hajimiSkinEmperorHint,
    dogInner,
    performanceButtons,
    notices,
    muteLog,
    externalNavigationLog,
    unlockConfirmOverlay,
    unlockConfirmTitle,
    unlockConfirmMessage,
    unlockConfirmCancel,
    unlockConfirmSubmit,
  };
}

async function initialize(harness) {
  const ready = harness.context.initializeToyCloudState();
  harness.context.toyStateReady = ready;
  await ready;
}

function option(harness, id) {
  return harness.options.find((item) => item.dataset.sfx === id);
}

function performanceButton(harness, settingName) {
  return harness.performanceButtons.find(
    (item) => item.dataset.setting === settingName
  );
}

for (const key of [
  'dagou_settings_seen_v1',
  'dagou_dingdong_new_seen_v1',
  'dagou_hajimi_new_seen_v1',
  'dagou_piano_mode_v1',
  'dagou_rhythm_snap_v1',
  'dagou_show_grid_v1',
]) {
  assert.ok(mainSource.includes(`'${key}'`), `Missing cloud key ${key}`);
}
assert.doesNotMatch(
  mainSource,
  /dagou_sfx_unlocked_v1|DEBUG_UNLOCK_SFX|getUserProfile/,
  'unlock state and profile consent must not participate in the new flow'
);
assert.match(
  htmlSource,
  /<div id="author-link"[^>]*aria-hidden="true"/,
  'the corner author credit must be decorative rather than a link'
);
assert.doesNotMatch(
  mainSource,
  /authorLink\.addEventListener/,
  'the corner author credit must not register navigation handlers'
);

const hajimiAtlasPath = new URL(
  '../Image/donghaidihuang_atlas.webp',
  import.meta.url,
);
assert.ok(fs.existsSync(hajimiAtlasPath), 'missing lossless Hajimi frame atlas');
assert.ok(
  fs.statSync(hajimiAtlasPath).size < 7 * 1024 * 1024,
  'lossless Hajimi frame atlas must stay below 7 MiB'
);
const hajimiAtlasBytes = fs.readFileSync(hajimiAtlasPath);
let webpOffset = 12;
let atlasWidth = null;
let atlasHeight = null;
let hasAnimationChunk = false;
while (webpOffset + 8 <= hajimiAtlasBytes.length) {
  const chunkName = hajimiAtlasBytes.toString(
    'ascii',
    webpOffset,
    webpOffset + 4,
  );
  const chunkSize = hajimiAtlasBytes.readUInt32LE(webpOffset + 4);
  const chunkData = webpOffset + 8;
  if (chunkName === 'VP8X' && chunkSize >= 10) {
    atlasWidth = hajimiAtlasBytes.readUIntLE(chunkData + 4, 3) + 1;
    atlasHeight = hajimiAtlasBytes.readUIntLE(chunkData + 7, 3) + 1;
  }
  if (chunkName === 'ANIM' || chunkName === 'ANMF') hasAnimationChunk = true;
  webpOffset = chunkData + chunkSize + (chunkSize % 2);
}
assert.equal(atlasWidth, 4320, 'Hajimi atlas must contain 12 frame columns');
assert.equal(atlasHeight, 4626, 'Hajimi atlas must contain 9 frame rows');
assert.equal(hasAnimationChunk, false, 'atlas timing must be controlled by Web Audio');
assert.ok(
  fs.existsSync(new URL('../Image/donghaidihuang_icon.webp', import.meta.url)),
  'missing Hajimi animation button icon',
);

const dingdongButton = htmlSource.match(
  /<button class="([^"]*)"[^>]*data-sfx="dingdong"/
);
assert.ok(dingdongButton, 'Missing dingdong option');
assert.match(dingdongButton[1], /\bis-locked\b/, 'dingdong must start locked');
const dagouButton = htmlSource.match(
  /<button class="([^"]*)"[^>]*data-sfx="dagou"/
);
assert.ok(dagouButton);
assert.doesNotMatch(dagouButton[1], /\bis-locked\b/, 'dagou must stay unlocked');
assert.doesNotMatch(dagouButton[1], /\bis-active\b/, 'dagou must not be the default');
const hajimiButton = htmlSource.match(
  /<button class="([^"]*)"[^>]*data-sfx="hajimi"/
);
assert.ok(hajimiButton, 'Missing hajimi option');
assert.doesNotMatch(
  hajimiButton[1],
  /\bis-locked\b/,
  'original Hajimi must stay unlocked'
);
assert.match(hajimiButton[1], /\bis-active\b/, 'Hajimi must be the default');
const hajimiButtonBlock = htmlSource.match(
  /<button class="[^"]*"[^>]*data-sfx="hajimi"[\s\S]*?<\/button>/
);
assert.ok(hajimiButtonBlock, 'Missing hajimi option block');
assert.doesNotMatch(
  hajimiButtonBlock[0],
  /sfx-lock|sfx-new/,
  'the Hajimi sound card must never carry a lock or NEW badge'
);
assert.doesNotMatch(
  htmlSource,
  /is-character-(toggle|locked)|is-animation-active/,
  'the ambiguous on-card character lock must be gone'
);
assert.match(
  htmlSource,
  /class="skin-switcher is-open" id="hajimi-skin-switcher"/,
  'the skin switcher must start expanded for the default Hajimi'
);
const classicSkin = htmlSource.match(
  /<button class="([^"]*)"[^>]*data-skin="classic"/
);
assert.ok(classicSkin, 'Missing classic skin option');
assert.match(classicSkin[1], /\bis-active\b/, 'classic skin must be the default');
assert.doesNotMatch(classicSkin[1], /\bis-locked\b/, 'classic skin is never locked');
const emperorSkin = htmlSource.match(
  /<button class="([^"]*)"[^>]*data-skin="emperor"/
);
assert.ok(emperorSkin, 'Missing emperor skin option');
assert.match(
  emperorSkin[1],
  /\bis-locked\b/,
  'only the emperor skin option starts locked'
);
const emperorSkinBlock = htmlSource.match(
  /<button class="[^"]*"[^>]*data-skin="emperor"[\s\S]*?<\/button>/
);
assert.ok(emperorSkinBlock, 'Missing emperor skin block');
assert.match(
  emperorSkinBlock[0],
  /sfx-lock[\s\S]*?skin-hint">投币开发视频解锁/,
  'the lock and the unlock hint must both live on the emperor skin option'
);
assert.match(
  htmlSource,
  /id="settings-hint" aria-hidden="true"[\s\S]*?settings-hint-arrow[\s\S]*?点击设置<br \/>切换大狗叫音效/,
  'the settings hint must pair a prominent arrow with the switch-sound copy'
);
assert.match(
  htmlSource,
  /#top-controls\.has-update-dot #settings-hint\s*{\s*opacity:\s*1/,
  'the settings hint must appear together with the red dot'
);
assert.match(
  htmlSource,
  /#settings-hint\s*{[^}]*pointer-events:\s*none/,
  'the settings hint must never block stage taps'
);
assert.match(
  htmlSource,
  /id="dog-inner" class="is-hajimi"[\s\S]*?id="dog-close" src="Image\/maodie_close_mouth\.png" alt="哈基米"[\s\S]*?id="dog-open" src="Image\/maodie_open_mouth\.png"/,
  'the stage must start with original Hajimi'
);
assert.match(
  htmlSource,
  /<img src="Image\/dingdongji_close_mouth\.png" alt="" draggable="false" \/>/,
  'the Dingdong option must use the supplied close-mouth image'
);
assert.match(
  htmlSource,
  /id="top-controls" class="[^"]*\bhas-update-dot\b[^"]*"/,
  'the default visible red dot must pin settings before cloud state loads'
);
assert.match(
  htmlSource,
  /#dog-open\s*{[^}]*position:\s*absolute;[^}]*opacity:\s*0;[^}]*transition:\s*opacity \.08s linear;[^}]*}/,
  'the original layered dog image transition must remain intact'
);
assert.match(
  htmlSource,
  /#dog-inner\.bark-image #dog-open\s*{\s*opacity:\s*1;\s*}/,
  'the original open-mouth dog image transition must remain intact'
);
assert.match(
  htmlSource,
  /#dog-inner\.is-hajimi\.bark-image #dog-close\s*{\s*visibility:\s*hidden;\s*}/,
  'only Hajimi must hide its close-mouth image while barking'
);
assert.match(
  htmlSource,
  /#dog-inner\.is-hajimi\.bark-image #dog-open\s*{\s*visibility:\s*visible;\s*}/,
  'only Hajimi must reveal its open-mouth image while barking'
);
assert.match(
  htmlSource,
  /#dog-inner\.is-hajimi\.is-hajimi-animation #dog-close,[\s\S]*?#dog-inner\.is-hajimi\.is-hajimi-animation #dog-open\s*{\s*visibility:\s*hidden;\s*}/,
  'the looping character must suppress both Hajimi mouth images'
);
assert.match(
  htmlSource,
  /id="dog-animation"[^>]*width="360"[^>]*height="514"[^>]*aria-hidden="true"/,
  'the looping character must render through the fixed-size frame canvas'
);
assert.match(
  htmlSource,
  /id="dog-animation-atlas"[^>]*hidden[^>]*decoding="async"[^>]*fetchpriority="low"/,
  'the lossless atlas must be a lazy low-priority image'
);
for (const [settingName, defaultChecked] of [
  ['pianoMode', 'false'],
  ['octaveSwitching', 'false'],
  ['rhythmSnap', 'true'],
  ['showGrid', 'false'],
]) {
  assert.match(
    htmlSource,
    new RegExp(`data-setting="${settingName}"[^>]*aria-checked="${defaultChecked}"|aria-checked="${defaultChecked}"[^>]*data-setting="${settingName}"`),
    `Missing default markup for ${settingName}`,
  );
}

{
  const setup = makeToy();
  const harness = makeHarness(setup.toy);
  await initialize(harness);
  assert.equal(harness.context.toyCloudState.cloudReadable, true);
  assert.equal(harness.context.toyCloudState.sfxUnlocked, false);
  assert.equal(harness.context.updateDot.classList.contains('is-hidden'), false);
  assert.equal(harness.context.topControls.classList.contains('has-update-dot'), true);
  assert.equal(option(harness, 'dingdong').classList.contains('is-locked'), true);
  assert.equal(option(harness, 'hajimi').classList.contains('is-locked'), false);
  assert.equal(
    harness.hajimiSkinEmperor.classList.contains('is-locked'),
    true,
    'the emperor skin chip starts locked instead of the Hajimi card'
  );
  assert.equal(harness.hajimiSkinEmperorHint.textContent, '投币开发视频解锁');
  assert.equal(harness.hajimiSkinSwitcher.classList.contains('is-open'), true);
  assert.equal(option(harness, 'hajimi').classList.contains('is-active'), true);
  assert.equal(option(harness, 'dagou').classList.contains('is-locked'), false);
  assert.deepEqual(
    { ...harness.context.performanceSettings },
    {
      pianoMode: false,
      octaveSwitching: false,
      pianoOctaveStart: 4,
      rhythmSnap: true,
      showGrid: false,
    },
  );
  assert.equal(harness.context.octaveSwitchingSetting.hidden, true);
  assert.equal(harness.performanceButtons.every(button => !button.disabled), true);
}

{
  const setup = makeToy({
    cloud: {
      dagou_sfx_unlocked_v1: '1',
      dagou_settings_seen_v1: '1',
      dagou_dingdong_new_seen_v1: '1',
      dagou_hajimi_new_seen_v1: '1',
      dagou_piano_mode_v1: '1',
      dagou_octave_switching_v1: '1',
      dagou_piano_octave_start_v1: '6',
      dagou_rhythm_snap_v1: '0',
      dagou_show_grid_v1: '1',
    },
  });
  const harness = makeHarness(setup.toy);
  await initialize(harness);
  assert.equal(
    harness.context.toyCloudState.sfxUnlocked,
    false,
    'the legacy cloud unlock value must be ignored',
  );
  assert.equal(harness.context.updateDot.classList.contains('is-hidden'), true);
  assert.equal(harness.context.topControls.classList.contains('has-update-dot'), false);
  assert.equal(option(harness, 'dingdong').classList.contains('is-locked'), true);
  assert.equal(
    harness.hajimiSkinEmperor.classList.contains('is-locked'),
    true
  );
  assert.equal(harness.hajimiSkinEmperorHint.textContent, '投币开发视频解锁');
  assert.equal(
    harness.hajimiSkinEmperor.classList.contains('is-new-hidden'),
    true
  );
  assert.deepEqual(
    { ...harness.context.performanceSettings },
    {
      pianoMode: true,
      octaveSwitching: true,
      pianoOctaveStart: 6,
      rhythmSnap: false,
      showGrid: true,
    },
  );
  assert.equal(harness.context.octaveSwitchingSetting.hidden, false);
}

{
  const setup = makeToy({
    cloud: {
      dagou_piano_mode_v1: '1',
      dagou_octave_switching_v1: '1',
      dagou_piano_octave_start_v1: '9',
    },
  });
  const harness = makeHarness(setup.toy);
  await initialize(harness);
  assert.equal(
    harness.context.performanceSettings.pianoOctaveStart,
    4,
    'invalid cloud octave values must fall back to C4',
  );
  assert.equal(
    harness.context.performanceSettings.octaveSwitching,
    false,
    'invalid cloud octave values must also disable octave switching',
  );
}

{
  const harness = makeHarness(null);
  await initialize(harness);
  assert.equal(harness.context.updateDot.classList.contains('is-hidden'), false);
  assert.equal(option(harness, 'dingdong').classList.contains('is-locked'), true);
  assert.equal(await harness.context.requireToyUnlockContext(), null);
  assert.equal(
    harness.notices.at(-1).message,
    '无法检查投币状态（错误ID：COIN-E01）。请在B站打开此页面或更新哔哩哔哩APP后重试。'
  );
  await harness.context.openFeaturedVideo();
  assert.deepEqual(harness.externalNavigationLog, [
    'https://www.bilibili.com/video/BV1kNKU6REBg/',
  ]);
  assert.equal(harness.context.toyCloudState.sfxUnlocked, false);
  assert.deepEqual(
    { ...harness.context.performanceSettings },
    {
      pianoMode: false,
      octaveSwitching: false,
      pianoOctaveStart: 4,
      rhythmSnap: true,
      showGrid: false,
    },
  );
  assert.equal(harness.performanceButtons.every(button => !button.disabled), true);
  await harness.context.handlePerformanceSettingClick(
    performanceButton(harness, 'pianoMode')
  );
  assert.equal(harness.context.performanceSettings.pianoMode, true);
  assert.match(harness.notices.at(-1).message, /仅在当前页面有效/);
}

{
  const setup = makeToy({
    support: { getVideoUserActions: false },
  });
  const harness = makeHarness(setup.toy);
  await initialize(harness);
  await harness.context.handleSfxOptionClick(option(harness, 'dingdong'));
  assert.equal(harness.context.unlockConfirmOpen, false);
  assert.equal(
    harness.notices.at(-1).message,
    '无法检查投币状态（错误ID：COIN-E01）。请在B站打开此页面或更新哔哩哔哩APP后重试。'
  );
}

{
  const harness = makeHarness(null);
  await initialize(harness);
  await harness.context.handleSfxOptionClick(option(harness, 'dagou'));
  assert.equal(harness.context.selectedSfxId, 'dagou');
  assert.equal(option(harness, 'dagou').classList.contains('is-active'), true);
  assert.equal(
    harness.hajimiSkinSwitcher.classList.contains('is-open'),
    false,
    'the skin switcher must collapse when Hajimi is not selected'
  );
  assert.equal(harness.hajimiSkinClassic.disabled, true);
  await harness.context.handleSfxOptionClick(option(harness, 'hajimi'));
  assert.equal(harness.context.selectedSfxId, 'hajimi');
  assert.equal(option(harness, 'hajimi').classList.contains('is-active'), true);
  assert.equal(harness.context.hajimiAnimationEnabled, false);
  assert.equal(harness.dogAnimationAtlas.src, undefined);
  assert.equal(harness.hajimiSkinSwitcher.classList.contains('is-open'), true);
  await harness.context.handleSfxOptionClick(option(harness, 'hajimi'));
  assert.equal(
    harness.notices.length,
    0,
    're-clicking the Hajimi card must not trigger the unlock flow'
  );
  await harness.context.handleSkinOptionClick(harness.hajimiSkinEmperor);
  assert.equal(harness.context.hajimiAnimationEnabled, false);
  assert.equal(
    harness.notices.at(-1).message,
    '无法检查投币状态（错误ID：COIN-E01）。请在B站打开此页面或更新哔哩哔哩APP后重试。'
  );
}

{
  const setup = makeToy({ coinCount: 1 });
  const harness = makeHarness(setup.toy);
  await initialize(harness);
  assert.equal(harness.context.toyCloudState.sfxUnlocked, true);
  assert.ok(setup.log.includes('authorVideos:BV1kNKU6REBg'));
  assert.ok(setup.log.includes('videoActions:123456789'));
  assert.equal(option(harness, 'hajimi').classList.contains('is-locked'), false);
  assert.equal(
    harness.hajimiSkinEmperor.classList.contains('is-locked'),
    false
  );
  assert.equal(option(harness, 'hajimi').classList.contains('is-active'), true);
  assert.equal(harness.dogCloseImage.src, 'Image/maodie_close_mouth.png');
  assert.equal(harness.dogCloseImage.alt, '哈基米');
  assert.equal(harness.dogOpenImage.src, 'Image/maodie_open_mouth.png');
  assert.equal(harness.dogInner.classList.contains('is-hajimi'), true);
  assert.equal(
    harness.hajimiSkinClassic.classList.contains('is-active'),
    true
  );
  assert.equal(
    harness.hajimiSkinEmperor.classList.contains('is-active'),
    false
  );
  assert.equal(harness.dogAnimationAtlas.src, undefined);
  assert.equal(harness.hajimiOptionImage.src, 'Image/maodie_close_mouth.png');
  assert.equal(harness.dogInner.classList.contains('is-hajimi-animation'), false);

  // The emperor asset stays lazy until an unlocked user explicitly switches to it.
  await harness.context.handleSkinOptionClick(harness.hajimiSkinEmperor);
  assert.equal(
    harness.dogAnimationAtlas.src,
    'Image/donghaidihuang_atlas.webp?v=20260721-beat-synced'
  );
  assert.equal(harness.context.hajimiAnimationEnabled, true);
  assert.equal(harness.dogInner.classList.contains('is-hajimi-animation'), false);
  harness.context.hajimiAnimationReady = true;
  harness.context.applyHajimiAnimationVisibility();
  assert.equal(harness.dogInner.classList.contains('is-hajimi-animation'), true);
  assert.equal(harness.dogCloseImage.alt, '');
  assert.equal(harness.dogAnimationCanvas.attributes.get('aria-hidden'), 'false');
  assert.equal(harness.hajimiOptionImage.src, 'Image/donghaidihuang_icon.webp');
  assert.equal(
    harness.hajimiSkinEmperor.classList.contains('is-active'),
    true
  );
  assert.equal(
    harness.hajimiSkinEmperor.attributes.get('aria-checked'),
    'true'
  );
  assert.equal(
    harness.hajimiSkinClassic.classList.contains('is-active'),
    false
  );

  harness.context.hajimiAnimationFrame = -1;
  harness.dogAnimationDraws.length = 0;
  for (const beatPosition of [0, 1, 8.999, 9]) {
    harness.context.renderHajimiAnimationFrame(beatPosition);
  }
  assert.deepEqual(
    harness.dogAnimationDraws.map((draw) => draw.slice(1, 3)),
    [[0, 0], [0, 514], [3960, 4112], [0, 0]],
    'frame 0 must land on the accent and return exactly every nine beats',
  );

  harness.context.started = true;
  harness.context.startTime = 1;
  harness.context.ctx = { currentTime: 1 + 3.4 * (60 / 128) };
  harness.context.alignHajimiAnimationToBeat();
  assert.equal(
    harness.context.hajimiAnimationEpochBeat,
    4,
    'switching mid-beat must align frame 0 to the next beat head',
  );
  harness.context.started = false;
  harness.context.ctx = null;

  await harness.context.handleSkinOptionClick(harness.hajimiSkinClassic);
  assert.equal(harness.dogInner.classList.contains('is-hajimi-animation'), false);
  assert.equal(harness.dogAnimationCanvas.attributes.get('aria-hidden'), 'true');
  assert.equal(harness.dogCloseImage.alt, '哈基米');
  assert.equal(harness.hajimiOptionImage.src, 'Image/maodie_close_mouth.png');
  assert.equal(
    harness.hajimiSkinClassic.classList.contains('is-active'),
    true
  );
  assert.equal(
    harness.hajimiSkinEmperor.classList.contains('is-active'),
    false
  );

  harness.context.selectSfxOption(option(harness, 'dingdong'));
  assert.equal(harness.dogCloseImage.src, 'Image/dingdongji_close_mouth.png');
  assert.equal(harness.dogCloseImage.alt, '叮咚鸡');
  assert.equal(harness.dogOpenImage.src, 'Image/dingdongji_open_mouth.png');
  assert.equal(harness.dogInner.classList.contains('is-hajimi'), false);
  harness.context.selectSfxOption(option(harness, 'dagou'));
  assert.equal(harness.dogCloseImage.src, 'Image/dagou_close_mouth.png');
  assert.equal(harness.dogOpenImage.src, 'Image/dagou_open_mouth.png');
  assert.equal(harness.dogInner.classList.contains('is-hajimi'), false);
  assert.match(harness.notices[0].message, /正在加载东海帝皇动画/);
}

{
  const setup = makeToy({ getError: new Error('read failed'), coinCount: 1 });
  const harness = makeHarness(setup.toy);
  await initialize(harness);
  assert.equal(harness.context.toyCloudState.cloudReadable, false);
  assert.equal(harness.context.updateDot.classList.contains('is-hidden'), false);
  assert.equal(option(harness, 'hajimi').classList.contains('is-locked'), false);
  assert.equal(
    harness.hajimiSkinEmperor.classList.contains('is-locked'),
    false
  );
  assert.equal(
    harness.context.toyCloudState.sfxUnlocked,
    true,
    'cloud read failures must not block a successful coin verification',
  );
  assert.equal(await harness.context.requireToyUnlockContext(), harness.context.toyCloudState);
  setup.log.length = 0;
  await harness.context.openFeaturedVideo();
  assert.deepEqual(setup.log, ['navigate:video:BV1kNKU6REBg']);
  assert.equal(harness.context.toyCloudState.sfxUnlocked, true);
  assert.deepEqual(
    { ...harness.context.performanceSettings },
    {
      pianoMode: false,
      octaveSwitching: false,
      pianoOctaveStart: 4,
      rhythmSnap: true,
      showGrid: false,
    },
  );
  assert.equal(harness.performanceButtons.every(button => !button.disabled), true);
}

{
  const setup = makeToy();
  const harness = makeHarness(setup.toy);
  await initialize(harness);
  setup.log.length = 0;
  await harness.context.handlePerformanceSettingClick(
    performanceButton(harness, 'pianoMode')
  );
  assert.deepEqual(setup.log, ['set:dagou_piano_mode_v1']);
  assert.equal(setup.storage.dagou_piano_mode_v1, '1');
  assert.equal(harness.context.performanceSettings.pianoMode, true);
  assert.equal(
    performanceButton(harness, 'pianoMode').attributes.get('aria-checked'),
    'true',
  );
}

{
  let releaseFirstWrite;
  let writeCount = 0;
  const firstWriteGate = new Promise(resolve => { releaseFirstWrite = resolve; });
  const setup = makeToy({
    cloud: {
      dagou_piano_mode_v1: '1',
      dagou_octave_switching_v1: '1',
      dagou_piano_octave_start_v1: '4',
    },
    setHandler: async () => {
      writeCount++;
      if (writeCount === 1) await firstWriteGate;
    },
  });
  const harness = makeHarness(setup.toy);
  await initialize(harness);
  setup.log.length = 0;
  harness.context.shiftPianoOctave(1);
  harness.context.shiftPianoOctave(1);
  assert.equal(harness.context.performanceSettings.pianoOctaveStart, 6);
  releaseFirstWrite();
  while (harness.context.pianoOctaveCloudWriteRunning) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.deepEqual(setup.log, ['set:dagou_piano_octave_start_v1']);
  assert.equal(
    setup.storage.dagou_piano_octave_start_v1,
    '6',
    'serialized octave writes must finish with the latest selected value',
  );
}

{
  const setup = makeToy({
    cloud: {
      dagou_piano_mode_v1: '1',
      dagou_rhythm_snap_v1: '0',
      dagou_show_grid_v1: '1',
    },
    setError: new Error('settings write failed'),
  });
  const harness = makeHarness(setup.toy);
  await initialize(harness);
  await harness.context.handlePerformanceSettingClick(
    performanceButton(harness, 'showGrid')
  );
  assert.deepEqual(
    { ...harness.context.performanceSettings },
    {
      pianoMode: true,
      octaveSwitching: false,
      pianoOctaveStart: 4,
      rhythmSnap: false,
      showGrid: false,
    },
  );
  assert.equal(harness.context.toyCloudState.cloudReadable, false);
  assert.equal(harness.performanceButtons.every(button => !button.disabled), true);
  assert.match(harness.notices.at(-1).message, /仅在当前页面有效/);
}

{
  const setup = makeToy();
  const harness = makeHarness(setup.toy);
  await initialize(harness);
  harness.context.settingsOpen = true;
  harness.context.settingsOverlay.inert = false;
  setup.log.length = 0;
  await harness.context.handleSfxOptionClick(option(harness, 'dingdong'));
  await Promise.resolve();
  assert.equal(option(harness, 'dingdong').classList.contains('is-active'), false);
  assert.equal(option(harness, 'dingdong').classList.contains('is-new-hidden'), true);
  assert.equal(
    setup.storage.dagou_dingdong_new_seen_v1,
    '1',
    'clicking a locked option must persist its NEW state'
  );
  assert.equal(harness.context.unlockConfirmOpen, true);
  assert.equal(harness.unlockConfirmOverlay.classList.contains('is-open'), true);
  assert.equal(harness.unlockConfirmOverlay.inert, false);
  assert.equal(harness.context.settingsOverlay.inert, true);
  assert.equal(harness.unlockConfirmTitle.textContent, '解锁叮咚鸡');
  assert.match(harness.unlockConfirmMessage.textContent, /是否现在前往投币/);
  assert.equal(harness.notices.length, 0);
  harness.context.closeUnlockConfirm();
  assert.equal(harness.context.unlockConfirmOpen, false);
  assert.equal(harness.context.settingsOverlay.inert, false);
  await harness.context.handleSfxOptionClick(option(harness, 'hajimi'));
  await Promise.resolve();
  assert.equal(
    harness.context.toyCloudState.newSeen.hajimi,
    false,
    'clicking the Hajimi card must not touch the emperor skin state'
  );
  await harness.context.handleSkinOptionClick(harness.hajimiSkinEmperor);
  await Promise.resolve();
  assert.equal(harness.context.hajimiAnimationEnabled, false);
  assert.equal(option(harness, 'hajimi').classList.contains('is-active'), true);
  assert.equal(
    harness.hajimiSkinEmperor.classList.contains('is-new-hidden'),
    true
  );
  assert.equal(setup.storage.dagou_hajimi_new_seen_v1, '1');
  assert.equal(harness.context.unlockConfirmOpen, true);
  assert.equal(harness.unlockConfirmTitle.textContent, '解锁哈基米（帝皇）');
  assert.match(harness.unlockConfirmMessage.textContent, /同时解锁叮咚鸡和哈基米（帝皇）/);
}

{
  let releaseNavigation;
  const navigationGate = new Promise((resolve) => { releaseNavigation = resolve; });
  const setup = makeToy({ navigateHandler: async () => navigationGate });
  const harness = makeHarness(setup.toy);
  await initialize(harness);
  harness.context.settingsOpen = true;
  harness.context.settingsOverlay.inert = false;
  await harness.context.handleSfxOptionClick(option(harness, 'dingdong'));
  await Promise.resolve();
  setup.log.length = 0;
  assert.equal(harness.context.unlockConfirmOpen, true);

  const confirmation = harness.context.confirmUnlockFromVideo();
  for (let i = 0; i < 5 && setup.log.length === 0; i++) {
    await Promise.resolve();
  }

  assert.equal(harness.context.toyCloudState.sfxUnlocked, false);
  assert.equal(option(harness, 'dingdong').classList.contains('is-locked'), true);
  assert.equal(harness.hajimiSkinEmperor.classList.contains('is-locked'), true);
  assert.equal(harness.unlockConfirmSubmit.textContent, '打开中…');
  assert.equal(harness.unlockConfirmSubmit.disabled, true);
  assert.deepEqual(setup.log, ['navigate:video:BV1kNKU6REBg']);

  releaseNavigation();
  await confirmation;

  assert.equal(harness.context.toyCloudState.sfxUnlocked, false);
  assert.equal(harness.unlockConfirmSubmit.textContent, '前往视频投币');
  assert.equal(harness.unlockConfirmSubmit.disabled, false);
  assert.equal(harness.context.unlockConfirmOpen, false);
}

{
  const setup = makeToy();
  const harness = makeHarness(setup.toy);
  await initialize(harness);
  setup.setCoinCount(1);
  setup.log.length = 0;
  await harness.context.handleSfxOptionClick(option(harness, 'dingdong'));
  assert.deepEqual(setup.log, [
    'set:dagou_dingdong_new_seen_v1',
    'videoActions:123456789',
  ]);
  assert.equal(harness.context.toyCloudState.sfxUnlocked, true);
  assert.equal(option(harness, 'dingdong').classList.contains('is-locked'), false);
  assert.equal(harness.hajimiSkinEmperor.classList.contains('is-locked'), false);
  assert.equal(option(harness, 'dingdong').classList.contains('is-active'), true);
  assert.equal(harness.context.unlockConfirmOpen, false);
}

{
  const setup = makeToy({ coinCount: 2 });
  const harness = makeHarness(setup.toy);
  await initialize(harness);
  assert.equal(harness.context.toyCloudState.sfxUnlocked, true);
  assert.equal(option(harness, 'dingdong').classList.contains('is-locked'), false);
  assert.equal(harness.hajimiSkinEmperor.classList.contains('is-locked'), false);
}

{
  const setup = makeToy({
    authorVideosResponse: {
      status: 'ok',
      items: [{ status: 'ok', aid: 0, bvid: 'BV1kNKU6REBg' }],
    },
  });
  const harness = makeHarness(setup.toy);
  await initialize(harness);
  assert.equal(harness.context.toyCloudState.sfxUnlocked, false);
  await harness.context.handleSfxOptionClick(option(harness, 'dingdong'));
  assert.equal(harness.context.unlockConfirmOpen, false);
  assert.match(harness.notices.at(-1).message, /错误ID：COIN-A04/);
}

{
  const setup = makeToy({
    videoActionsResponse: {
      status: 'ok',
      items: [{ status: 'ok', aid: 987654321, coinCount: 2 }],
    },
  });
  const harness = makeHarness(setup.toy);
  await initialize(harness);
  assert.equal(
    harness.context.toyCloudState.sfxUnlocked,
    false,
    'an action item for another aid must never unlock the featured video rewards',
  );
  await harness.context.handleSfxOptionClick(option(harness, 'dingdong'));
  assert.match(harness.notices.at(-1).message, /错误ID：COIN-U03/);
}

{
  const setup = makeToy({
    videoActionsResponse: {
      items: [{ liked: false, coinCount: 1, favorited: false }],
    },
  });
  const harness = makeHarness(setup.toy);
  await initialize(harness);
  assert.equal(
    harness.context.toyCloudState.sfxUnlocked,
    true,
    'a single ordered action item may omit aid as documented by the SDK example',
  );
}

{
  const setup = makeToy({
    coinCount: 1,
    authorVideosResponse: {
      items: [{
        data: { aid: 123456789, bvid: 'BV1kNKU6REBg' },
      }],
    },
  });
  const harness = makeHarness(setup.toy);
  await initialize(harness);
  assert.equal(
    harness.context.toyCloudState.sfxUnlocked,
    true,
    'nested author-video payloads must still resolve the target aid',
  );
}

{
  const setup = makeToy({ videoActionsError: new Error('not logged in') });
  const harness = makeHarness(setup.toy);
  await initialize(harness);
  await harness.context.handleSfxOptionClick(option(harness, 'dingdong'));
  assert.equal(harness.context.toyCloudState.sfxUnlocked, false);
  assert.equal(harness.context.unlockConfirmOpen, false);
  assert.match(harness.notices.at(-1).message, /错误ID：COIN-U01/);
}

{
  const setup = makeToy({ navigateError: new Error('navigation failed') });
  const harness = makeHarness(setup.toy);
  await initialize(harness);
  setup.log.length = 0;
  await harness.context.openFeaturedVideo();
  assert.equal(harness.context.toyCloudState.sfxUnlocked, false);
  assert.match(harness.notices.at(-1).message, /视频打开失败/);
  assert.equal(harness.muteLog.at(-1), false);
}

{
  const setup = makeToy();
  const harness = makeHarness(setup.toy);
  await initialize(harness);
  let creatorNavigationCount = 0;
  harness.context.openCreatorSpace = () => {
    creatorNavigationCount++;
  };

  harness.context.handleAuthorHomeClick();
  assert.equal(
    creatorNavigationCount,
    0,
    'the hidden author home button must not navigate while settings are closed'
  );

  harness.context.openSettings();
  assert.equal(harness.context.settingsOverlay.inert, false);
  harness.context.handleAuthorHomeClick();
  assert.equal(creatorNavigationCount, 1);
  harness.context.closeSettings();
  assert.equal(harness.context.settingsOverlay.inert, true);
  harness.context.handleAuthorHomeClick();
  assert.equal(
    creatorNavigationCount,
    1,
    'closing settings must disable subsequent author home clicks'
  );
}

assert.match(
  htmlSource,
  /id="settings-overlay"[^>]*\binert\b/,
  'the settings dialog must start inert before JavaScript runs'
);
assert.match(
  htmlSource,
  /id="unlock-confirm-overlay"[^>]*aria-hidden="true"[^>]*\binert\b/,
  'the centered unlock confirmation must start hidden and inert'
);
assert.match(
  htmlSource,
  /id="unlock-confirm-dialog"[^>]*role="dialog"[^>]*aria-modal="true"/,
  'the unlock confirmation must expose modal dialog semantics'
);
assert.match(
  htmlSource,
  /id="unlock-confirm-submit"[^>]*>前往视频投币<\/button>/,
  'the unlock confirmation must provide an explicit coin action'
);
assert.doesNotMatch(
  mainSource,
  /delayAfterCloudWriteMs|optimisticUnlock|dagou_sfx_unlocked_v1/,
  'video navigation must not optimistically or persistently unlock content'
);
assert.doesNotMatch(
  `${htmlSource}\n${mainSource}`,
  /观看开发视频(?:后)?解锁|前往视频解锁|跳转中…/,
  'all watch-to-unlock copy must be replaced by coin-to-unlock copy',
);

{
  const setup = makeToy();
  const harness = makeHarness(setup.toy);
  await initialize(harness);
  harness.context.markSettingsSeen();
  assert.equal(harness.context.updateDot.classList.contains('is-hidden'), true);
  assert.equal(harness.context.topControls.classList.contains('has-update-dot'), false);
  harness.context.settingsOpen = true;
  harness.context.closeSettings();
  assert.equal(option(harness, 'dingdong').classList.contains('is-new-hidden'), true);
  assert.equal(
    harness.hajimiSkinEmperor.classList.contains('is-new-hidden'),
    true
  );
}

const stagePointerStart = mainSource.indexOf("stage.addEventListener('pointerdown'");
const stagePointerEnd = mainSource.indexOf("stage.addEventListener('pointermove'", stagePointerStart);
assert.ok(stagePointerStart >= 0 && stagePointerEnd > stagePointerStart);
assert.doesNotMatch(
  mainSource.slice(stagePointerStart, stagePointerEnd),
  /markSettingsSeen|settingsSeen/,
  'stage performance clicks must not clear the settings dot'
);

console.log('Toy coin unlock and cloud settings flow verified:');
console.log('- Hajimi original is the default and freely switches with Dagou');
console.log('- the Hajimi sound card never shows a lock; the lock lives on the emperor skin chip');
console.log('- only Dingdong and the dedicated emperor skin chip start locked');
console.log('- the settings hint arrow appears and disappears together with the red dot');
console.log('- author-video lookup converts the fixed BV id to an aid before action lookup');
console.log('- one or more coins unlock Dingdong and the emperor skin together');
console.log('- locked-item clicks recheck coins and guide unpaid users to the video');
console.log('- confirmed video navigation never changes or persists the unlock state');
console.log('- cloud read failures do not block successful coin verification');
console.log('- videos still open outside Toy without unlocking');
console.log('- failed coin reads remain locked; failed navigation keeps the current state');
console.log('- settings red dot and per-option NEW states persist independently');
console.log('- a visible red dot pins only the settings button while audio controls hide');
console.log('- performance defaults, cloud restore/write, and local-only fallback switching');
console.log('- the emperor skin chip lazily loads and toggles the looping character');
console.log('- Web Audio clock returns the lossless atlas to frame 0 every nine beats');
