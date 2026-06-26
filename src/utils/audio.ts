export async function audioBufferToMono22050(audioBuffer: AudioBuffer): Promise<Float32Array> {
  const numChannels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const sampleRate = audioBuffer.sampleRate;

  // Mix to mono
  const mono = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (let c = 0; c < numChannels; c++) {
      sum += audioBuffer.getChannelData(c)[i];
    }
    mono[i] = sum / numChannels;
  }

  if (sampleRate === 22050) {
    return mono;
  }

  // Resample to 22050 using OfflineAudioContext
  const tempBuffer = new AudioBuffer({
    length: mono.length,
    numberOfChannels: 1,
    sampleRate: sampleRate,
  });
  tempBuffer.copyToChannel(mono, 0);

  const targetLength = Math.ceil(mono.length * 22050 / sampleRate);
  const offlineCtx = new OfflineAudioContext(1, targetLength, 22050);
  const source = offlineCtx.createBufferSource();
  source.buffer = tempBuffer;
  source.connect(offlineCtx.destination);
  source.start();

  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0);
}

export async function stereoToAudioBuffer(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number
): Promise<AudioBuffer> {
  const length = left.length;
  const buffer = new AudioBuffer({
    length,
    numberOfChannels: 2,
    sampleRate,
  });
  buffer.copyToChannel(left, 0);
  buffer.copyToChannel(right, 1);
  return buffer;
}

export async function resampleTo44100(audioBuffer: AudioBuffer): Promise<AudioBuffer> {
  if (audioBuffer.sampleRate === 44100) {
    return audioBuffer;
  }

  const targetLength = Math.ceil(audioBuffer.length * 44100 / audioBuffer.sampleRate);
  const offlineCtx = new OfflineAudioContext(
    audioBuffer.numberOfChannels,
    targetLength,
    44100
  );

  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineCtx.destination);
  source.start();

  return await offlineCtx.startRendering();
}
