// dsh-plugin-pvz-perf host fixture: the sound engine registers this worklet.
registerProcessor('pvz-music-worklet', class extends AudioWorkletProcessor {
  process() {
    return true
  }
})
