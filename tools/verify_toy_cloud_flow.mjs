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
  'applyPerformanceSettings',
  'replacePerformanceSettings',
  'resetPerformanceSettingsToDefaults',
  'markToyCloudUnavailable',
  'readCloudPerformanceSettings',
  'renderPerformanceSettings',
  'renderToyCloudState',
  'detectToyEnvironment',
  'initializeToyCloudState',
  'persistSeenState',
  'markSettingsSeen',
  'markSfxNewSeen',
  'markAllSfxNewSeen',
  'requireToyCloudContext',
  'selectSfxOption',
  'openSettings',
  'closeSettings',
  'handleSfxOptionClick',
  'handlePerformanceSettingClick',
];
const extractedFunctions = functionNames.map(extractFunction).join('\n');

function makeToy({
  cloud = {},
  support = true,
  profile = { nickname: '测试用户', avatar: 'https://example.com/avatar.png' },
  getError = null,
  setError = null,
  navigateError = null,
} = {}) {
  const log = [];
  const storage = { ...cloud };
  const toy = {
    async isSupport(ability) {
      log.push(`support:${ability}`);
      return support;
    },
    async getUserProfile() {
      log.push('profile');
      return profile;
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
      Object.assign(storage, items);
    },
    async navigate(request) {
      log.push(`navigate:${request.type}:${request.id}`);
      if (navigateError) throw navigateError;
    },
  };
  return { toy, log, storage };
}

function makeHarness(toy) {
  const options = [
    new FakeElement({ classes: ['sfx-option', 'is-active'], dataset: { sfx: 'dagou' } }),
    new FakeElement({ classes: ['sfx-option', 'is-locked'], dataset: { sfx: 'dingdong' } }),
    new FakeElement({ classes: ['sfx-option', 'is-locked'], dataset: { sfx: 'hajimi' } }),
  ];
  const dogCloseImage = new FakeElement();
  const dogOpenImage = new FakeElement();
  const dogInner = new FakeElement();
  const notices = [];
  const performanceButtons = [
    new FakeElement({ dataset: { setting: 'pianoMode' } }),
    new FakeElement({ dataset: { setting: 'rhythmSnap' } }),
    new FakeElement({ dataset: { setting: 'showGrid' } }),
  ];
  const muteLog = [];
  const externalNavigationLog = [];
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
    setTimeout: () => 1,
    clearTimeout() {},
    TOY_CLOUD_KEYS: {
      sfxUnlocked: 'dagou_sfx_unlocked_v1',
      settingsSeen: 'dagou_settings_seen_v1',
      dingdongNewSeen: 'dagou_dingdong_new_seen_v1',
      hajimiNewSeen: 'dagou_hajimi_new_seen_v1',
      pianoMode: 'dagou_piano_mode_v1',
      rhythmSnap: 'dagou_rhythm_snap_v1',
      showGrid: 'dagou_show_grid_v1',
    },
    TOY_CLOUD_KEY_LIST: [
      'dagou_sfx_unlocked_v1',
      'dagou_settings_seen_v1',
      'dagou_dingdong_new_seen_v1',
      'dagou_hajimi_new_seen_v1',
      'dagou_piano_mode_v1',
      'dagou_rhythm_snap_v1',
      'dagou_show_grid_v1',
    ],
    TOY_REQUIRED_ABILITIES: [
      'getUserProfile',
      'getCloudStorage',
      'setCloudStorage',
      'navigate',
    ],
    LOCKED_SFX_IDS: new Set(['dingdong', 'hajimi']),
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
    selectedSfxId: 'dagou',
    // Keep the baseline cases validating the normal release/cloud-lock flow.
    // The dedicated debug case below opts into the temporary bypass explicitly.
    DEBUG_UNLOCK_SFX: false,
    DEFAULT_PERFORMANCE_SETTINGS: Object.freeze({
      pianoMode: false,
      rhythmSnap: true,
      showGrid: false,
    }),
    PERFORMANCE_SETTING_KEYS: Object.freeze({
      pianoMode: 'dagou_piano_mode_v1',
      rhythmSnap: 'dagou_rhythm_snap_v1',
      showGrid: 'dagou_show_grid_v1',
    }),
    performanceSettings: {
      pianoMode: false,
      rhythmSnap: true,
      showGrid: false,
    },
    performanceSettingsSaving: false,
    performanceSettingButtons: performanceButtons,
    performanceSettingsStatus: new FakeElement(),
    zones: [{}],
    clearQueuedPerformanceInput() {},
    renderKeyGrid() {},
    buildGrid() {},
    FEATURED_BVID: 'BV1kNKU6REBg',
    FEATURED_VIDEO_URL: 'https://www.bilibili.com/video/BV1kNKU6REBg/',
    sfxOptions: options,
    dogCloseImage,
    dogOpenImage,
    dogInner,
    topControls: new FakeElement(),
    updateDot: new FakeElement(),
    toyNotice: new FakeElement(),
    videoCard: new FakeElement(),
    settingsOverlay: new FakeElement(),
    settingsButton: new FakeElement(),
    settingsClose: new FakeElement(),
    settingsOpen: false,
    videoUnlockPending: false,
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
    dogInner,
    performanceButtons,
    notices,
    muteLog,
    externalNavigationLog,
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
  'dagou_sfx_unlocked_v1',
  'dagou_settings_seen_v1',
  'dagou_dingdong_new_seen_v1',
  'dagou_hajimi_new_seen_v1',
  'dagou_piano_mode_v1',
  'dagou_rhythm_snap_v1',
  'dagou_show_grid_v1',
]) {
  assert.ok(mainSource.includes(`'${key}'`), `Missing cloud key ${key}`);
}
assert.match(
  mainSource,
  /const DEBUG_UNLOCK_SFX = true;/,
  'temporary debug unlock must remain explicit and easy to disable'
);

for (const id of ['dingdong', 'hajimi']) {
  const button = htmlSource.match(
    new RegExp(`<button class="([^"]*)"[^>]*data-sfx="${id}"`)
  );
  assert.ok(button, `Missing ${id} option`);
  assert.match(button[1], /\bis-locked\b/, `${id} must start locked`);
}
const dagouButton = htmlSource.match(
  /<button class="([^"]*)"[^>]*data-sfx="dagou"/
);
assert.ok(dagouButton);
assert.doesNotMatch(dagouButton[1], /\bis-locked\b/, 'dagou must stay unlocked');
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
for (const [settingName, defaultChecked] of [
  ['pianoMode', 'false'],
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
  assert.equal(option(harness, 'hajimi').classList.contains('is-locked'), true);
  assert.equal(option(harness, 'dagou').classList.contains('is-locked'), false);
  assert.deepEqual(
    { ...harness.context.performanceSettings },
    { pianoMode: false, rhythmSnap: true, showGrid: false },
  );
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
      dagou_rhythm_snap_v1: '0',
      dagou_show_grid_v1: '1',
    },
  });
  const harness = makeHarness(setup.toy);
  await initialize(harness);
  assert.equal(harness.context.toyCloudState.sfxUnlocked, true);
  assert.equal(harness.context.updateDot.classList.contains('is-hidden'), true);
  assert.equal(harness.context.topControls.classList.contains('has-update-dot'), false);
  assert.equal(option(harness, 'dingdong').classList.contains('is-locked'), false);
  assert.equal(option(harness, 'hajimi').classList.contains('is-new-hidden'), true);
  assert.deepEqual(
    { ...harness.context.performanceSettings },
    { pianoMode: true, rhythmSnap: false, showGrid: true },
  );
}

{
  const harness = makeHarness(null);
  await initialize(harness);
  assert.equal(harness.context.updateDot.classList.contains('is-hidden'), false);
  assert.equal(option(harness, 'dingdong').classList.contains('is-locked'), true);
  assert.equal(await harness.context.requireToyCloudContext(), null);
  assert.equal(harness.notices.at(-1).message, '请在哔哩哔哩内打开');
  await harness.context.openFeaturedVideo();
  assert.deepEqual(harness.externalNavigationLog, [
    'https://www.bilibili.com/video/BV1kNKU6REBg/',
  ]);
  assert.equal(harness.context.toyCloudState.sfxUnlocked, false);
  assert.deepEqual(
    { ...harness.context.performanceSettings },
    { pianoMode: false, rhythmSnap: true, showGrid: false },
  );
  assert.equal(harness.performanceButtons.every(button => !button.disabled), true);
  await harness.context.handlePerformanceSettingClick(
    performanceButton(harness, 'pianoMode')
  );
  assert.equal(harness.context.performanceSettings.pianoMode, true);
  assert.match(harness.notices.at(-1).message, /仅在当前页面有效/);
}

{
  const harness = makeHarness(null);
  await initialize(harness);
  harness.context.toyCloudState.sfxUnlocked = true;
  harness.context.renderToyCloudState();
  await harness.context.handleSfxOptionClick(option(harness, 'hajimi'));
  assert.equal(option(harness, 'hajimi').classList.contains('is-locked'), false);
  assert.equal(option(harness, 'hajimi').classList.contains('is-active'), true);
  assert.equal(harness.dogCloseImage.src, 'Image/maodie_close_mouth.png');
  assert.equal(harness.dogCloseImage.alt, '哈基米');
  assert.equal(harness.dogOpenImage.src, 'Image/maodie_open_mouth.png');
  assert.equal(harness.dogInner.classList.contains('is-hajimi'), true);
  harness.context.selectSfxOption(option(harness, 'dingdong'));
  assert.equal(harness.dogCloseImage.src, 'Image/dingdongji_close_mouth.png');
  assert.equal(harness.dogCloseImage.alt, '叮咚鸡');
  assert.equal(harness.dogOpenImage.src, 'Image/dingdongji_open_mouth.png');
  assert.equal(harness.dogInner.classList.contains('is-hajimi'), false);
  harness.context.selectSfxOption(option(harness, 'dagou'));
  assert.equal(harness.dogCloseImage.src, 'Image/dagou_close_mouth.png');
  assert.equal(harness.dogOpenImage.src, 'Image/dagou_open_mouth.png');
  assert.equal(harness.dogInner.classList.contains('is-hajimi'), false);
  assert.equal(harness.notices.length, 0);
}

{
  const setup = makeToy({ getError: new Error('read failed') });
  const harness = makeHarness(setup.toy);
  await initialize(harness);
  assert.equal(harness.context.toyCloudState.cloudReadable, false);
  assert.equal(harness.context.updateDot.classList.contains('is-hidden'), false);
  assert.equal(option(harness, 'hajimi').classList.contains('is-locked'), true);
  assert.equal(await harness.context.requireToyCloudContext(), null);
  assert.match(harness.notices.at(-1).message, /云端状态读取失败/);
  setup.log.length = 0;
  await harness.context.openFeaturedVideo();
  assert.deepEqual(setup.log, ['navigate:video:BV1kNKU6REBg']);
  assert.equal(harness.context.toyCloudState.sfxUnlocked, false);
  assert.deepEqual(
    { ...harness.context.performanceSettings },
    { pianoMode: false, rhythmSnap: true, showGrid: false },
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
    { pianoMode: true, rhythmSnap: false, showGrid: false },
  );
  assert.equal(harness.context.toyCloudState.cloudReadable, false);
  assert.equal(harness.performanceButtons.every(button => !button.disabled), true);
  assert.match(harness.notices.at(-1).message, /仅在当前页面有效/);
}

{
  const setup = makeToy();
  const harness = makeHarness(setup.toy);
  await initialize(harness);
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
  assert.match(harness.notices.at(-1).message, /点击上方开发视频/);
}

{
  const setup = makeToy();
  const harness = makeHarness(setup.toy);
  await initialize(harness);
  setup.log.length = 0;
  await harness.context.openFeaturedVideo();
  assert.deepEqual(setup.log, [
    'set:dagou_sfx_unlocked_v1',
    'navigate:video:BV1kNKU6REBg',
  ]);
  assert.equal(harness.context.toyCloudState.sfxUnlocked, true);
  assert.equal(option(harness, 'dingdong').classList.contains('is-locked'), false);
}

{
  const setup = makeToy({ setError: new Error('write failed') });
  const harness = makeHarness(setup.toy);
  await initialize(harness);
  setup.log.length = 0;
  await harness.context.openFeaturedVideo();
  assert.equal(setup.log.includes('navigate:video:BV1kNKU6REBg'), false);
  assert.equal(harness.context.toyCloudState.sfxUnlocked, false);
  assert.match(harness.notices.at(-1).message, /解锁失败/);
}

{
  const setup = makeToy({ navigateError: new Error('navigation failed') });
  const harness = makeHarness(setup.toy);
  await initialize(harness);
  setup.log.length = 0;
  await harness.context.openFeaturedVideo();
  assert.equal(harness.context.toyCloudState.sfxUnlocked, true);
  assert.match(harness.notices.at(-1).message, /已完成解锁，但视频打开失败/);
  assert.equal(harness.muteLog.at(-1), false);
}

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
  assert.equal(option(harness, 'hajimi').classList.contains('is-new-hidden'), true);
}

const stagePointerStart = mainSource.indexOf("stage.addEventListener('pointerdown'");
const stagePointerEnd = mainSource.indexOf("stage.addEventListener('pointermove'", stagePointerStart);
assert.ok(stagePointerStart >= 0 && stagePointerEnd > stagePointerStart);
assert.doesNotMatch(
  mainSource.slice(stagePointerStart, stagePointerEnd),
  /markSettingsSeen|settingsSeen/,
  'stage performance clicks must not clear the settings dot'
);

console.log('Toy cloud unlock flow verified:');
console.log('- only dingdong and hajimi start locked');
console.log('- unavailable cloud reads keep the red dot visible and options locked');
console.log('- cloud unlock is written before Toy video navigation');
console.log('- videos still open outside Toy or without readable cloud state, without unlocking');
console.log('- failed writes never navigate; failed navigation keeps the unlock');
console.log('- settings red dot and per-option NEW states persist independently');
console.log('- a visible red dot pins only the settings button while audio controls hide');
console.log('- the temporary debug switch unlocks both options without Toy capabilities');
console.log('- performance defaults, cloud restore/write, and local-only fallback switching');
