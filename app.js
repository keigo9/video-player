'use strict';

(() => {
  // ===== 定数 =====
  const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3];
  const SPEED_MIN = 0.25;
  const SPEED_MAX = 4;
  const SPEED_STEP = 0.05;
  const SEEK_SHORT = 5;
  const SEEK_LONG = 10;
  const FRAME_SEC = 1 / 30; // コマ送り幅（フレームレートは取得できないため 30fps 想定）
  const VOLUME_STEP = 0.1;
  const MAX_TIME_INPUT_LENGTH = 12;
  const STORAGE_KEY_SPEED = 'videoPlayer.speed';
  const STORAGE_KEY_VOLUME = 'videoPlayer.volume';
  const OSD_DURATION_MS = 900;
  const VIDEO_EXTENSIONS = /\.(mp4|m4v|webm|mov|ogv|ogg|mkv)$/i;

  // ===== DOM 参照 =====
  const $ = (id) => document.getElementById(id);
  const el = {
    dropZone: $('dropZone'),
    fileInput: $('fileInput'),
    player: $('player'),
    fileName: $('fileName'),
    changeFileBtn: $('changeFileBtn'),
    videoWrap: $('videoWrap'),
    video: $('video'),
    osd: $('osd'),
    currentTime: $('currentTime'),
    duration: $('duration'),
    seekBar: $('seekBar'),
    playBtn: $('playBtn'),
    stopBtn: $('stopBtn'),
    back10Btn: $('back10Btn'),
    fwd10Btn: $('fwd10Btn'),
    muteBtn: $('muteBtn'),
    volumeBar: $('volumeBar'),
    fullscreenBtn: $('fullscreenBtn'),
    speedValue: $('speedValue'),
    speedPresets: $('speedPresets'),
    speedBar: $('speedBar'),
    speedDownBtn: $('speedDownBtn'),
    speedUpBtn: $('speedUpBtn'),
    jumpForm: $('jumpForm'),
    jumpInput: $('jumpInput'),
    jumpError: $('jumpError'),
    useCurrentBtn: $('useCurrentBtn'),
    status: $('status'),
  };

  // ===== 状態 =====
  const state = {
    objectUrl: null,
    isSeeking: false,
    osdTimer: 0,
  };

  // ===== ユーティリティ =====
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  /** 秒数を「h:mm:ss」または「m:ss」形式に変換する */
  function formatTime(totalSeconds) {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
    const sec = Math.floor(totalSeconds);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  /**
   * 「90」「1:30」「1:02:03」「1:30.5」形式の文字列を秒数に変換する。
   * 不正な入力の場合は null を返す。
   */
  function parseTime(input) {
    const text = input.trim().replace(/：/g, ':').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    if (text.length === 0 || text.length > MAX_TIME_INPUT_LENGTH) return null;
    if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(text)) return null;

    const parts = text.split(':');
    const last = Number(parts.pop());
    const units = parts.map(Number);
    // 分・秒の部分は 60 未満でなければならない（先頭の単位は除く）
    if (units.length > 0 && last >= 60) return null;
    if (units.length === 2 && units[1] >= 60) return null;

    return units.reduce((acc, n) => acc * 60 + n, 0) * 60 + last;
  }

  function roundSpeed(value) {
    return Math.round(value * 100) / 100;
  }

  // ===== 永続化（localStorage は使えない環境もあるので必ず try/catch） =====
  function loadNumber(key, fallback, min, max) {
    try {
      const raw = localStorage.getItem(key);
      const value = raw === null ? NaN : Number(raw);
      return Number.isFinite(value) ? clamp(value, min, max) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveNumber(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch {
      // 保存できなくても動作には影響しないので無視
    }
  }

  // ===== メッセージ表示 =====
  function showStatus(message, isError = false) {
    el.status.textContent = message;
    el.status.classList.toggle('is-error', isError);
  }

  /** 動画の上に一瞬だけ情報を表示する */
  function showOsd(message) {
    el.osd.textContent = message;
    el.osd.classList.add('is-visible');
    clearTimeout(state.osdTimer);
    state.osdTimer = setTimeout(() => el.osd.classList.remove('is-visible'), OSD_DURATION_MS);
  }

  // ===== ファイル読み込み =====
  /** 動画ファイルとして扱ってよいかを検証する */
  function validateFile(file) {
    if (!(file instanceof File)) return '有効なファイルではありません。';
    // OS によっては MIME タイプが空になるので、その場合は拡張子で判定する
    const isVideo = file.type
      ? file.type.startsWith('video/')
      : VIDEO_EXTENSIONS.test(file.name);
    if (!isVideo) {
      return `動画ファイルを選んでください（選択されたファイル形式: ${file.type || '不明'}）。`;
    }
    // canPlayType が '' でも実際は再生できる形式（.mov 等）があるため、
    // ここでは弾かずに video 要素の error イベントで判定する
    return null;
  }

  /** 以前の blob URL を解放してメモリリークを防ぐ */
  function releaseCurrentVideo() {
    el.video.pause();
    el.video.removeAttribute('src');
    el.video.load();
    if (state.objectUrl) {
      URL.revokeObjectURL(state.objectUrl);
      state.objectUrl = null;
    }
  }

  function loadFile(file) {
    const error = validateFile(file);
    if (error) {
      showStatus(error, true);
      return;
    }

    releaseCurrentVideo();
    state.objectUrl = URL.createObjectURL(file);
    el.video.src = state.objectUrl;
    // ファイル名はユーザー入力なので textContent で安全に表示する
    el.fileName.textContent = file.name;
    el.fileName.title = file.name;
    el.dropZone.hidden = true;
    el.player.hidden = false;
    showStatus('');
    clearJumpError();
  }

  /** iPhone / iPad かどうか（iPadOS は Mac として振る舞うのでタッチ対応で判定） */
  function isIOS() {
    return /iPhone|iPad|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function openFilePicker() {
    el.fileInput.value = '';
    el.fileInput.click();
  }

  function setupFileInput() {
    // 写真ライブラリから選ぶと iOS 側の変換で遅くなるため、iOS ではヒントを出す
    $('iosTip').hidden = !isIOS();
    el.dropZone.addEventListener('click', openFilePicker);
    el.dropZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openFilePicker();
      }
    });
    el.changeFileBtn.addEventListener('click', openFilePicker);
    el.fileInput.addEventListener('change', () => {
      const file = el.fileInput.files && el.fileInput.files[0];
      if (file) loadFile(file);
    });
  }

  /** ページ全体でドラッグ＆ドロップを受け付ける（再生中でも差し替え可能） */
  function setupDragAndDrop() {
    let dragDepth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

    document.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth += 1;
      el.dropZone.classList.add('is-dragover');
    });
    document.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) el.dropZone.classList.remove('is-dragover');
    });
    document.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      el.dropZone.classList.remove('is-dragover');
      const files = e.dataTransfer.files;
      if (files.length > 1) showStatus('複数ファイルがドロップされたため、最初の1つを開きます。');
      if (files.length > 0) loadFile(files[0]);
    });
  }

  // ===== 再生・停止 =====
  function hasVideo() {
    return Boolean(state.objectUrl);
  }

  async function play() {
    if (!hasVideo()) return;
    try {
      await el.video.play();
    } catch (err) {
      if (err && err.name !== 'AbortError') showStatus('再生を開始できませんでした。', true);
    }
  }

  function togglePlay() {
    if (!hasVideo()) return;
    if (el.video.paused || el.video.ended) play();
    else el.video.pause();
  }

  function stop() {
    if (!hasVideo()) return;
    el.video.pause();
    el.video.currentTime = 0;
    showOsd('⏹ 停止');
  }

  function updatePlayButton() {
    const playing = !el.video.paused && !el.video.ended;
    el.playBtn.textContent = playing ? '⏸ 一時停止' : '▶ 再生';
    el.playBtn.setAttribute('aria-label', playing ? '一時停止' : '再生');
  }

  // ===== シーク =====
  function seekTo(seconds) {
    if (!hasVideo()) return;
    const duration = Number.isFinite(el.video.duration) ? el.video.duration : seconds;
    el.video.currentTime = clamp(seconds, 0, duration);
    updateTimeDisplay();
  }

  function seekBy(delta) {
    seekTo(el.video.currentTime + delta);
    showOsd(`${delta > 0 ? '⏩ +' : '⏪ '}${delta}秒`);
  }

  function stepFrame(direction) {
    if (!hasVideo()) return;
    el.video.pause();
    seekTo(el.video.currentTime + direction * FRAME_SEC);
    showOsd(direction > 0 ? 'コマ送り ▶' : '◀ コマ戻し');
  }

  function updateTimeDisplay() {
    el.currentTime.textContent = formatTime(el.video.currentTime);
    if (!state.isSeeking) el.seekBar.value = String(el.video.currentTime);
  }

  function updateDurationDisplay() {
    const duration = Number.isFinite(el.video.duration) ? el.video.duration : 0;
    el.duration.textContent = formatTime(duration);
    el.seekBar.max = String(duration);
  }

  function setupSeekBar() {
    el.seekBar.addEventListener('input', () => {
      state.isSeeking = true;
      el.video.currentTime = Number(el.seekBar.value);
      el.currentTime.textContent = formatTime(Number(el.seekBar.value));
    });
    el.seekBar.addEventListener('change', () => {
      state.isSeeking = false;
    });
  }

  // ===== 再生速度 =====
  function setSpeed(value) {
    const speed = roundSpeed(clamp(value, SPEED_MIN, SPEED_MAX));
    el.video.playbackRate = speed;
    el.video.defaultPlaybackRate = speed;
    saveNumber(STORAGE_KEY_SPEED, speed);
    updateSpeedDisplay(speed);
    return speed;
  }

  function changeSpeedBy(delta) {
    const speed = setSpeed(el.video.playbackRate + delta);
    showOsd(`${speed.toFixed(2)}x`);
  }

  function updateSpeedDisplay(speed) {
    el.speedValue.textContent = `${speed.toFixed(2)}x`;
    el.speedBar.value = String(speed);
    for (const chip of el.speedPresets.children) {
      chip.setAttribute('aria-pressed', String(Number(chip.dataset.speed) === speed));
    }
  }

  function renderSpeedPresets() {
    for (const speed of SPEED_PRESETS) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.speed = String(speed);
      chip.textContent = `${speed}x`;
      chip.setAttribute('aria-pressed', 'false');
      chip.addEventListener('click', () => {
        setSpeed(speed);
        showOsd(`${speed.toFixed(2)}x`);
      });
      el.speedPresets.appendChild(chip);
    }
  }

  function setupSpeedControls() {
    renderSpeedPresets();
    el.speedBar.addEventListener('input', () => setSpeed(Number(el.speedBar.value)));
    el.speedDownBtn.addEventListener('click', () => changeSpeedBy(-SPEED_STEP));
    el.speedUpBtn.addEventListener('click', () => changeSpeedBy(SPEED_STEP));
    setSpeed(loadNumber(STORAGE_KEY_SPEED, 1, SPEED_MIN, SPEED_MAX));
  }

  // ===== 時間指定再生 =====
  function showJumpError(message) {
    el.jumpError.textContent = message;
    el.jumpInput.setAttribute('aria-invalid', 'true');
  }

  function clearJumpError() {
    el.jumpError.textContent = '';
    el.jumpInput.removeAttribute('aria-invalid');
  }

  function handleJumpSubmit(e) {
    e.preventDefault();
    if (!hasVideo()) return;

    const seconds = parseTime(el.jumpInput.value);
    if (seconds === null) {
      showJumpError('時間の形式が正しくありません。例: 90 / 1:30 / 1:02:03');
      return;
    }
    const duration = el.video.duration;
    if (Number.isFinite(duration) && seconds > duration) {
      showJumpError(`動画の長さ（${formatTime(duration)}）を超えています。`);
      return;
    }

    clearJumpError();
    seekTo(seconds);
    showOsd(`▶ ${formatTime(seconds)} から再生`);
    play();
  }

  function setupJumpForm() {
    el.jumpForm.addEventListener('submit', handleJumpSubmit);
    el.jumpInput.addEventListener('input', clearJumpError);
    el.useCurrentBtn.addEventListener('click', () => {
      el.jumpInput.value = formatTime(el.video.currentTime);
      clearJumpError();
      el.jumpInput.focus();
    });
  }

  // ===== 音量・全画面 =====
  function setVolume(value) {
    const volume = clamp(Math.round(value * 100) / 100, 0, 1);
    el.video.volume = volume;
    el.video.muted = volume === 0;
    saveNumber(STORAGE_KEY_VOLUME, volume);
  }

  function changeVolumeBy(delta) {
    setVolume(el.video.volume + delta);
    showOsd(`🔊 ${Math.round(el.video.volume * 100)}%`);
  }

  function toggleMute() {
    el.video.muted = !el.video.muted;
    showOsd(el.video.muted ? '🔇 ミュート' : `🔊 ${Math.round(el.video.volume * 100)}%`);
  }

  function updateVolumeDisplay() {
    const muted = el.video.muted || el.video.volume === 0;
    el.muteBtn.textContent = muted ? '🔇' : '🔊';
    el.muteBtn.setAttribute('aria-label', muted ? 'ミュート解除' : 'ミュート');
    el.volumeBar.value = String(el.video.muted ? 0 : el.video.volume);
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await el.videoWrap.requestFullscreen();
    } catch {
      showStatus('全画面表示に切り替えられませんでした。', true);
    }
  }

  function setupVolumeAndFullscreen() {
    el.volumeBar.addEventListener('input', () => setVolume(Number(el.volumeBar.value)));
    el.muteBtn.addEventListener('click', toggleMute);
    el.fullscreenBtn.addEventListener('click', toggleFullscreen);
    if (!document.fullscreenEnabled) el.fullscreenBtn.hidden = true;
    setVolume(loadNumber(STORAGE_KEY_VOLUME, 1, 0, 1));
  }

  // ===== ボタン・動画イベント =====
  function setupPlaybackControls() {
    el.playBtn.addEventListener('click', togglePlay);
    el.stopBtn.addEventListener('click', stop);
    el.back10Btn.addEventListener('click', () => seekBy(-SEEK_LONG));
    el.fwd10Btn.addEventListener('click', () => seekBy(SEEK_LONG));
    el.video.addEventListener('click', togglePlay);
    el.video.addEventListener('dblclick', toggleFullscreen);
  }

  function setupVideoEvents() {
    const v = el.video;
    v.addEventListener('play', updatePlayButton);
    v.addEventListener('pause', updatePlayButton);
    v.addEventListener('ended', updatePlayButton);
    v.addEventListener('timeupdate', updateTimeDisplay);
    v.addEventListener('seeked', updateTimeDisplay);
    v.addEventListener('durationchange', updateDurationDisplay);
    v.addEventListener('volumechange', updateVolumeDisplay);
    v.addEventListener('loadedmetadata', () => {
      updateDurationDisplay();
      updateTimeDisplay();
      // 新しい動画を読み込むと速度がリセットされるので再適用する
      setSpeed(Number(el.speedBar.value));
      showStatus(`読み込み完了（長さ ${formatTime(v.duration)}）`);
    });
    v.addEventListener('error', () => {
      if (!hasVideo()) return;
      showStatus('動画を読み込めませんでした。ファイルが壊れているか、未対応のコーデックの可能性があります。', true);
    });
  }

  // ===== キーボードショートカット =====
  /** 入力欄などにフォーカスがあるときはショートカットを無効にする */
  function isTypingTarget(target) {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
    return target.tagName === 'INPUT' && target.type !== 'range';
  }

  const SHORTCUTS = {
    ' ': () => togglePlay(),
    k: () => togglePlay(),
    s: () => stop(),
    ArrowLeft: () => seekBy(-SEEK_SHORT),
    ArrowRight: () => seekBy(SEEK_SHORT),
    j: () => seekBy(-SEEK_LONG),
    l: () => seekBy(SEEK_LONG),
    ',': () => stepFrame(-1),
    '.': () => stepFrame(1),
    '[': () => changeSpeedBy(-SPEED_STEP),
    ']': () => changeSpeedBy(SPEED_STEP),
    0: () => { setSpeed(1); showOsd('1.00x'); },
    ArrowUp: () => changeVolumeBy(VOLUME_STEP),
    ArrowDown: () => changeVolumeBy(-VOLUME_STEP),
    m: () => toggleMute(),
    f: () => toggleFullscreen(),
    g: () => { el.jumpInput.focus(); el.jumpInput.select(); },
  };

  function handleKeydown(e) {
    if (!hasVideo() || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    if (isTypingTarget(e.target)) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    // ボタンにフォーカスがある時の Space / Enter はボタン本来の動作を優先する
    if (e.target instanceof HTMLButtonElement && (e.key === ' ' || e.key === 'Enter')) return;
    // スライダー操作中の矢印キーはスライダー本来の動作を優先する
    if (e.target instanceof HTMLInputElement && e.target.type === 'range' && e.key.startsWith('Arrow')) return;

    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const action = SHORTCUTS[key];
    if (!action) return;
    e.preventDefault();
    action();
  }

  // ===== 初期化 =====
  function init() {
    setupFileInput();
    setupDragAndDrop();
    setupPlaybackControls();
    setupSeekBar();
    setupSpeedControls();
    setupJumpForm();
    setupVolumeAndFullscreen();
    setupVideoEvents();
    document.addEventListener('keydown', handleKeydown);
  }

  init();
})();
