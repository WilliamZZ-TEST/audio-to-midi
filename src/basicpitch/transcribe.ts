import * as tf from '@tensorflow/tfjs';
import {
  BasicPitch,
  outputToNotesPoly,
  addPitchBendsToNoteEvents,
  noteFramesToTime,
} from '@spotify/basic-pitch';

const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@spotify/basic-pitch@1.0.1/model/model.json';

let basicPitchInstance: BasicPitch | null = null;

export async function getBasicPitch(): Promise<BasicPitch> {
  if (!basicPitchInstance) {
    // Force CPU backend to avoid WebGL unavailability issues
    await tf.ready();
    try {
      tf.setBackend('cpu');
    } catch (_) {
      // ignore if backend switch fails
    }
    basicPitchInstance = new BasicPitch(MODEL_URL);
  }
  return basicPitchInstance;
}

export interface TranscribedNote {
  startTimeSeconds: number;
  durationSeconds: number;
  pitchMidi: number;
  amplitude: number;
  pitchBends?: number[];
}

export async function transcribeToNotes(
  audioData: Float32Array,
  onProgress?: (percent: number) => void
): Promise<TranscribedNote[]> {
  const basicPitch = await getBasicPitch();

  const frames: number[][] = [];
  const onsets: number[][] = [];
  const contours: number[][] = [];

  await basicPitch.evaluateModel(
    audioData,
    (f, o, c) => {
      frames.push(...f);
      onsets.push(...o);
      contours.push(...c);
    },
    (pct) => {
      onProgress?.(pct);
    }
  );

  const notes = outputToNotesPoly(frames, onsets, 0.25, 0.25, 5);
  const notesWithBends = addPitchBendsToNoteEvents(contours, notes);
  const notesWithTime = noteFramesToTime(notesWithBends);

  return notesWithTime.map((n) => ({
    startTimeSeconds: n.startTimeSeconds,
    durationSeconds: n.durationSeconds,
    pitchMidi: n.pitchMidi,
    amplitude: n.amplitude,
    pitchBends: n.pitchBends,
  }));
}
