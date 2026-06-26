import MidiWriter from 'midi-writer-js';

export interface MidiTrackData {
  name: string;
  notes: {
    startTimeSeconds: number;
    durationSeconds: number;
    pitchMidi: number;
    amplitude: number;
    pitchBends?: number[];
  }[];
  instrument: number;
  channel: number;
}

// At default 120 BPM with 128 PPQ: 1 quarter = 0.5s, 1 tick = 0.5/128 s
// ticks = seconds * 128 / 0.5 = seconds * 256
const TICKS_PER_SECOND = 256;

export function buildMultiTrackMidi(tracks: MidiTrackData[]): Uint8Array {
  const midiTracks: MidiWriter.Track[] = [];

  for (const trackData of tracks) {
    const track = new MidiWriter.Track();
    track.addTrackName(trackData.name);

    if (trackData.channel === 10) {
      track.addEvent(new MidiWriter.ProgramChangeEvent({ instrument: 0, channel: 10 }));
    } else {
      track.addEvent(
        new MidiWriter.ProgramChangeEvent({
          instrument: trackData.instrument,
          channel: trackData.channel,
        })
      );
    }

    const sortedNotes = [...trackData.notes].sort(
      (a, b) => a.startTimeSeconds - b.startTimeSeconds
    );

    for (const note of sortedNotes) {
      const startTick = Math.round(note.startTimeSeconds * TICKS_PER_SECOND);
      const durationTicks = Math.max(1, Math.round(note.durationSeconds * TICKS_PER_SECOND));
      const velocity = Math.max(1, Math.min(100, Math.round(note.amplitude * 100)));

      const noteEvent = new MidiWriter.NoteEvent({
        pitch: [note.pitchMidi],
        duration: `T${durationTicks}`,
        velocity,
        channel: trackData.channel,
        startTick,
      });

      track.addEvent(noteEvent);

      // Add pitch bends if present
      if (note.pitchBends && note.pitchBends.length > 0) {
        const avgBend = note.pitchBends.reduce((a, b) => a + b, 0) / note.pitchBends.length;
        // basic-pitch contours are in semitones; MIDI pitch bend is +/- 2 semitones = +/- 8192
        const bendValue = Math.max(-1, Math.min(1, avgBend / 2));
        track.addEvent(
          new MidiWriter.PitchBendEvent({
            bend: bendValue,
            channel: trackData.channel,
            tick: startTick,
          })
        );
      }
    }

    midiTracks.push(track);
  }

  const writer = new MidiWriter.Writer(midiTracks);
  return writer.buildFile();
}

export function downloadMidi(data: Uint8Array, filename: string) {
  const blob = new Blob([data], { type: 'audio/midi' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
