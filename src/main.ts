import * as ort from 'onnxruntime-web';
import { loadDemucsModel, separateTracks, EXPORT_STEMS, type StemData } from './demucs/separate';
import { transcribeToNotes, type TranscribedNote } from './basicpitch/transcribe';
import { buildMultiTrackMidi, downloadMidi } from './midi/export';
import { audioBufferToMono22050 } from './utils/audio';
import './style.css';

// Configure ONNX Runtime WASM
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
ort.env.wasm.numThreads = navigator.hardwareConcurrency ?? 4;

const INSTRUMENT_MAP: Record<string, { instrument: number; channel: number }> = {
  vocals: { instrument: 91, channel: 1 },
  drums: { instrument: 0, channel: 10 },
  bass: { instrument: 33, channel: 2 },
  piano: { instrument: 1, channel: 3 },
  other: { instrument: 88, channel: 4 },
};

interface AppState {
  file: File | null;
  audioBuffer: AudioBuffer | null;
  separatedStems: StemData | null;
  transcribedNotes: Record<string, TranscribedNote[]> | null;
  pendingOneClick: boolean;
}

const state: AppState = {
  file: null,
  audioBuffer: null,
  separatedStems: null,
  transcribedNotes: null,
  pendingOneClick: false,
};

// UI Elements
const dropZone = document.getElementById('drop-zone') as HTMLDivElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const progressEl = document.getElementById('progress') as HTMLDivElement;
const stepsEl = document.getElementById('steps') as HTMLDivElement;
const uploadBtn = document.getElementById('btn-upload') as HTMLButtonElement;
const oneClickBtn = document.getElementById('btn-one-click') as HTMLButtonElement;
const separateBtn = document.getElementById('btn-separate') as HTMLButtonElement;
const transcribeBtn = document.getElementById('btn-transcribe') as HTMLButtonElement;
const exportBtn = document.getElementById('btn-export') as HTMLButtonElement;
const stemListEl = document.getElementById('stem-list') as HTMLDivElement;

function log(msg: string) {
  statusEl.textContent = msg;
  console.log(msg);
}

function setProgress(label: string, current: number, total: number) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  progressEl.textContent = `${label}: ${pct}% (${current}/${total})`;
}

function setStep(step: number) {
  const steps = stepsEl.querySelectorAll('.step');
  steps.forEach((s, i) => {
    s.classList.toggle('active', i === step - 1);
    s.classList.toggle('done', i < step - 1);
  });
}

// File upload handlers
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer?.files[0];
  if (file) loadFile(file);
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) loadFile(file);
});

// Upload button
uploadBtn.addEventListener('click', () => fileInput.click());

// Paste handler
document.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;

  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('audio/')) {
      const file = item.getAsFile();
      if (file) {
        e.preventDefault();
        loadFile(file);
        return;
      }
    }
  }
});

async function loadFile(file: File) {
  state.file = file;
  log(`加载音频: ${file.name}`);
  progressEl.textContent = '';

  try {
    const arrayBuffer = await file.arrayBuffer();
    const audioCtx = new AudioContext();
    state.audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

    log(
      `音频就绪: ${state.audioBuffer.duration.toFixed(2)}秒, ${state.audioBuffer.sampleRate}Hz, ${state.audioBuffer.numberOfChannels}声道`
    );
    setStep(1);
    separateBtn.disabled = false;
    transcribeBtn.disabled = true;
    exportBtn.disabled = true;
    stemListEl.innerHTML = '';
    state.separatedStems = null;
    state.transcribedNotes = null;

    if (state.pendingOneClick) {
      state.pendingOneClick = false;
      await runOneClick();
    }
  } catch (e: any) {
    log('加载失败: ' + e.message);
    console.error(e);
    state.pendingOneClick = false;
  }
}

// Step 2: Separate
separateBtn.addEventListener('click', async () => {
  if (!state.audioBuffer) return;
  separateBtn.disabled = true;
  progressEl.textContent = '';
  setStep(2);

  try {
    log('正在加载 Demucs 6s 模型 (~136MB)...');
    const session = await loadDemucsModel((loaded, total) => {
      const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
      progressEl.textContent = `加载模型: ${pct}%`;
    });

    log('正在分离音轨（人声/鼓/贝斯/钢琴/其他）...');
    const stems = await separateTracks(session, state.audioBuffer, (_stem, step, total) => {
      setProgress('分离音轨', step, total);
    });

    state.separatedStems = stems;
    log('音轨分离完成!');
    progressEl.textContent = '';

    stemListEl.innerHTML = '';
    for (const name of EXPORT_STEMS) {
      const data = stems[name];
      const div = document.createElement('div');
      div.className = 'stem-item';
      div.innerHTML = `<span>${translateStemName(name)}</span><span>${(data[0].length / 44100).toFixed(1)}s</span>`;
      stemListEl.appendChild(div);
    }

    transcribeBtn.disabled = false;
    setStep(2);
  } catch (e: any) {
    log('分离失败: ' + e.message);
    console.error(e);
    // Fallback: directly transcribe original audio
    log('模型不可用，尝试直接转录原始音频...');
    await runDirectTranscription();
    separateBtn.disabled = true;
  }
});

// Step 3: Transcribe
transcribeBtn.addEventListener('click', async () => {
  if (!state.separatedStems) return;
  transcribeBtn.disabled = true;
  progressEl.textContent = '';
  setStep(3);

  try {
    const notes: Record<string, TranscribedNote[]> = {};

    for (let i = 0; i < EXPORT_STEMS.length; i++) {
      const name = EXPORT_STEMS[i];
      log(`正在转录 ${translateStemName(name)}...`);

      const [left, right] = state.separatedStems[name];
      // Mix stereo to mono for basic-pitch (it downmixes anyway, but we do it explicitly at 22050)
      const tempBuffer = new AudioBuffer({
        length: left.length,
        numberOfChannels: 2,
        sampleRate: 44100,
      });
      tempBuffer.copyToChannel(left, 0);
      tempBuffer.copyToChannel(right, 1);

      const mono22050 = await audioBufferToMono22050(tempBuffer);
      const trackNotes = await transcribeToNotes(mono22050, (pct) => {
        setProgress(`转录 ${translateStemName(name)}`, Math.round(pct * 100), 100);
      });

      notes[name] = trackNotes;
      setProgress(`转录 ${translateStemName(name)}`, i + 1, EXPORT_STEMS.length);
    }

    state.transcribedNotes = notes;
    log('转录完成!');
    progressEl.textContent = '';

    // Update stem list with note counts
    stemListEl.innerHTML = '';
    for (const name of EXPORT_STEMS) {
      const data = state.separatedStems[name];
      const count = notes[name]?.length || 0;
      const div = document.createElement('div');
      div.className = 'stem-item';
      div.innerHTML = `<span>${translateStemName(name)} <span class="note-count">${count} 音符</span></span><span>${(data[0].length / 44100).toFixed(1)}s</span>`;
      stemListEl.appendChild(div);
    }

    exportBtn.disabled = false;
    setStep(3);
  } catch (e: any) {
    log('转录失败: ' + e.message);
    console.error(e);
    transcribeBtn.disabled = false;
  }
});

// Step 4: Export
exportBtn.addEventListener('click', () => {
  if (!state.transcribedNotes) return;
  setStep(4);

  // Fallback mode: single track from original audio
  if (state.transcribedNotes['original']) {
    const midiData = buildMultiTrackMidi([
      { name: '原始音频', notes: state.transcribedNotes['original'], instrument: 1, channel: 0 }
    ]);
    const filename = (state.file?.name.replace(/\.[^/.]+$/, '') || 'output') + '.mid';
    downloadMidi(midiData, filename);
    log(`MIDI 导出成功: ${filename}`);
    setStep(4);
    return;
  }

  // Normal mode: multi-track
  const tracks = EXPORT_STEMS.map((name) => ({
    name: translateStemName(name),
    notes: state.transcribedNotes![name] || [],
    ...INSTRUMENT_MAP[name],
  }));

  const midiData = buildMultiTrackMidi(tracks);
  const filename = (state.file?.name.replace(/\.[^/.]+$/, '') || 'output') + '.mid';
  downloadMidi(midiData, filename);

  log(`MIDI 导出成功: ${filename}`);
  setStep(4);
});

function translateStemName(name: string): string {
  const map: Record<string, string> = {
    vocals: '人声',
    drums: '鼓',
    bass: '贝斯',
    piano: '钢琴',
    other: '其他',
  };
  return map[name] || name;
}

// Fallback: directly transcribe original audio when separation model is unavailable
async function runDirectTranscription() {
  if (!state.audioBuffer) return;
  setStep(3);
  log('正在直接转录原始音频（无需分离模型）...');

  try {
    const mono22050 = await audioBufferToMono22050(state.audioBuffer);
    const notes = await transcribeToNotes(mono22050, (pct) => {
      setProgress('转录音频', Math.round(pct * 100), 100);
    });

    state.transcribedNotes = { original: notes };
    log(`转录完成! 检测到 ${notes.length} 个音符`);
    progressEl.textContent = '';

    stemListEl.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'stem-item';
    div.innerHTML = `<span>原始音频 <span class="note-count">${notes.length} 音符</span></span><span>${state.audioBuffer.duration.toFixed(1)}s</span>`;
    stemListEl.appendChild(div);

    exportBtn.disabled = false;
    setStep(3);
  } catch (e: any) {
    log('直接转录失败: ' + e.message);
    console.error(e);
    transcribeBtn.disabled = false;
  }
}

// One-click handler
oneClickBtn.addEventListener('click', async () => {
  if (!state.audioBuffer) {
    state.pendingOneClick = true;
    fileInput.click();
    log('请选择音频文件以开始一键处理');
    return;
  }
  await runOneClick();
});

async function runOneClick() {
  oneClickBtn.disabled = true;
  separateBtn.disabled = true;
  transcribeBtn.disabled = true;
  exportBtn.disabled = true;

  try {
    // Step 1 already done (file loaded)
    setStep(1);

    // Step 2: Separate (with fallback)
    if (!state.separatedStems && !state.transcribedNotes) {
      setStep(2);
      try {
        log('正在加载 Demucs 6s 模型 (~136MB)...');
        const session = await loadDemucsModel((loaded, total) => {
          const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
          progressEl.textContent = `加载模型: ${pct}%`;
        });

        log('正在分离音轨（人声/鼓/贝斯/钢琴/其他）...');
        const stems = await separateTracks(session, state.audioBuffer!, (_stem, step, total) => {
          setProgress('分离音轨', step, total);
        });

        state.separatedStems = stems;
        log('音轨分离完成!');
        progressEl.textContent = '';

        stemListEl.innerHTML = '';
        for (const name of EXPORT_STEMS) {
          const data = stems[name];
          const div = document.createElement('div');
          div.className = 'stem-item';
          div.innerHTML = `<span>${translateStemName(name)}</span><span>${(data[0].length / 44100).toFixed(1)}s</span>`;
          stemListEl.appendChild(div);
        }
      } catch (sepErr: any) {
        log('分离失败: ' + sepErr.message);
        console.error(sepErr);
        log('模型不可用，将直接转录原始音频...');
        await runDirectTranscription();
        if (!state.transcribedNotes?.['original']) {
          log('直接转录也失败了，请检查浏览器是否支持 WebGL');
          return;
        }
        // Skip to export after fallback transcription
        setStep(4);
        const midiData = buildMultiTrackMidi([
          { name: '原始音频', notes: state.transcribedNotes!['original'], instrument: 1, channel: 0 }
        ]);
        const filename = (state.file?.name.replace(/\.[^/.]+$/, '') || 'output') + '.mid';
        downloadMidi(midiData, filename);
        log(`一键导出成功: ${filename}`);
        setStep(4);
        return;
      }
    }

    // Step 3: Transcribe
    if (!state.transcribedNotes) {
      setStep(3);
      const notes: Record<string, TranscribedNote[]> = {};

      for (let i = 0; i < EXPORT_STEMS.length; i++) {
        const name = EXPORT_STEMS[i];
        log(`正在转录 ${translateStemName(name)}...`);

        const [left, right] = state.separatedStems![name];
        const tempBuffer = new AudioBuffer({
          length: left.length,
          numberOfChannels: 2,
          sampleRate: 44100,
        });
        tempBuffer.copyToChannel(left, 0);
        tempBuffer.copyToChannel(right, 1);

        const mono22050 = await audioBufferToMono22050(tempBuffer);
        const trackNotes = await transcribeToNotes(mono22050, (pct) => {
          setProgress(`转录 ${translateStemName(name)}`, Math.round(pct * 100), 100);
        });

        notes[name] = trackNotes;
        setProgress(`转录 ${translateStemName(name)}`, i + 1, EXPORT_STEMS.length);
      }

      state.transcribedNotes = notes;
      log('转录完成!');
      progressEl.textContent = '';

      stemListEl.innerHTML = '';
      for (const name of EXPORT_STEMS) {
        const data = state.separatedStems![name];
        const count = notes[name]?.length || 0;
        const div = document.createElement('div');
        div.className = 'stem-item';
        div.innerHTML = `<span>${translateStemName(name)} <span class="note-count">${count} 音符</span></span><span>${(data[0].length / 44100).toFixed(1)}s</span>`;
        stemListEl.appendChild(div);
      }
    }

    // Step 4: Export
    setStep(4);
    const tracks = EXPORT_STEMS.map((name) => ({
      name: translateStemName(name),
      notes: state.transcribedNotes![name] || [],
      ...INSTRUMENT_MAP[name],
    }));

    const midiData = buildMultiTrackMidi(tracks);
    const filename = (state.file?.name.replace(/\.[^/.]+$/, '') || 'output') + '.mid';
    downloadMidi(midiData, filename);

    log(`一键导出成功: ${filename}`);
    setStep(4);
  } catch (e: any) {
    log('一键处理失败: ' + e.message);
    console.error(e);
  } finally {
    oneClickBtn.disabled = false;
    separateBtn.disabled = !state.audioBuffer;
    transcribeBtn.disabled = !state.separatedStems;
    exportBtn.disabled = !state.transcribedNotes;
  }
}

// Initial state
separateBtn.disabled = true;
transcribeBtn.disabled = true;
exportBtn.disabled = true;
