// Feeder inputs for the two modes. Both feed the same pusher; only the
// feeder's inputs differ.
//
// Video mode: one normalized .mp4 per segment.
// Lofi mode:  the background loop (encoded once, video-only, constant
//             bitrate) repeated under each normalized audio track, all stream
//             copied — near-zero CPU. -shortest ends the segment with the
//             track; the joiner measures where it really ended, so a slight
//             video overshoot just becomes the next segment's offset.

const seekArgs = (seek) => (seek > 0 ? ['-ss', seek.toFixed(3)] : []);

export function videoInputs(file, seek = 0) {
  return [...seekArgs(seek), '-i', file, '-map', '0:v:0', '-map', '0:a:0'];
}

export function lofiInputs(backgroundFile, trackFile, seek = 0) {
  return [
    '-stream_loop', '-1', '-i', backgroundFile,
    ...seekArgs(seek), '-i', trackFile,
    '-map', '0:v:0', '-map', '1:a:0', '-shortest',
  ];
}
