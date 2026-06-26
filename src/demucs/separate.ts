import * as ort from 'onnxruntime-web';
import { resampleTo44100 } from '../utils/audio';

const SAMPLE_RATE = 44100;
const N_SAMPLES = Math.round(7.8 * SAMPLE_RATE); // 343980
const OVERLAP = Math.floor(N_SAMPLES / 4); // 85995
const STRIDE = N_SAMPLES - OVERLAP; // 257985

const ALL_STEMS = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'] as const;
export const EXPORT_STEMS = ['vocals', 'drums', 'bass', 'piano', 'other'] as const;

export type StemData = {
  [K in (typeof EXPORT_STEMS)[number]]: Float32Array[];
};

function makeTransitionWindow(seg: number, overlap: number): Float32Array {
  const w = new Float32Array(seg).fill(1);
  for (let i = 0; i < overlap; i++) {
    w[i] = i / overlap;
    w[seg - 1 - i] = i / overlap;
  }
  return w;
}

export async function loadDemucsModel(
  onProgress?: (loaded: number, total: number) => void
): Promise<ort.InferenceSession> {
  const modelUrl =
    'https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/main/htdemucs_6s_fp16weights.onnx';

  const response = await fetch(modelUrl);
  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }

  const allChunks = new Uint8Array(loaded);
  let position = 0;
  for (const chunk of chunks) {
    allChunks.set(chunk, position);
    position += chunk.length;
  }

  const session = await ort.InferenceSession.create(allChunks.buffer, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });

  return session;
}

export async function separateTracks(
  session: ort.InferenceSession,
  audioBuffer: AudioBuffer,
  onProgress?: (stem: string, step: number, total: number) => void
): Promise<StemData> {
  const resampled = await resampleTo44100(audioBuffer);
  const numChannels = resampled.numberOfChannels;

  const mix: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) {
    mix.push(resampled.getChannelData(c));
  }

  if (numChannels === 1) {
    mix.push(mix[0].slice());
  }

  const totalLength = mix[0].length;
  const nChunks = Math.max(1, Math.ceil((totalLength - OVERLAP) / STRIDE));
  const window = makeTransitionWindow(N_SAMPLES, OVERLAP);

  // outputs[stem][channel]
  const outputs: Float32Array[][] = [];
  for (let s = 0; s < 6; s++) {
    outputs.push([new Float32Array(totalLength), new Float32Array(totalLength)]);
  }
  const weight = new Float32Array(totalLength).fill(0);

  const chunkBuf = new Float32Array(2 * N_SAMPLES);

  for (let i = 0; i < nChunks; i++) {
    const start = i * STRIDE;
    const end = Math.min(start + N_SAMPLES, totalLength);
    const actualLen = end - start;

    chunkBuf.fill(0);
    for (let c = 0; c < 2; c++) {
      chunkBuf.set(mix[c].subarray(start, end), c * N_SAMPLES);
    }

    const result = await session.run({
      mix: new ort.Tensor('float32', chunkBuf, [1, 2, N_SAMPLES]),
    });

    const stems = result.stems.data as Float32Array;

    for (let s = 0; s < 6; s++) {
      const rowOffset = s * 2 * N_SAMPLES;
      for (let c = 0; c < 2; c++) {
        const channelOffset = rowOffset + c * N_SAMPLES;
        const out = outputs[s][c];
        for (let j = 0; j < actualLen; j++) {
          out[start + j] += stems[channelOffset + j] * window[j];
        }
      }
    }

    for (let j = 0; j < actualLen; j++) {
      weight[start + j] += window[j];
    }

    onProgress?.('all', i + 1, nChunks);
  }

  // Normalize
  for (let s = 0; s < 6; s++) {
    for (let c = 0; c < 2; c++) {
      const out = outputs[s][c];
      for (let i = 0; i < totalLength; i++) {
        out[i] /= Math.max(weight[i], 1e-8);
      }
    }
  }

  // Map to export stems: vocals(3), drums(0), bass(1), piano(5), other(2)
  const exportIndices = [3, 0, 1, 5, 2];
  const stemData = {} as StemData;

  for (let i = 0; i < EXPORT_STEMS.length; i++) {
    const name = EXPORT_STEMS[i];
    const srcIdx = exportIndices[i];
    stemData[name] = [outputs[srcIdx][0], outputs[srcIdx][1]];
  }

  return stemData;
}
