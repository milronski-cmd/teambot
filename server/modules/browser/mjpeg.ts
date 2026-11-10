import type { ServerResponse } from 'node:http';

const BOUNDARY = 'tbframe';
/** Boundary plus the headers of the next part. */
const NEXT_PART = `\r\n--${BOUNDARY}\r\nContent-Type: image/jpeg\r\n\r\n`;

/**
 * Start a live MJPEG response (multipart/x-mixed-replace; works in an <img>, also on phones) and return the function
 * that sends one JPEG frame.
 *
 * Browsers (Chromium at least) show a part only once the next part has begun, so a stream that writes
 * "boundary, headers, frame" per frame is always one frame behind: when a page then sits still (no new frames), the
 * live view keeps showing the previous page. Here every frame is followed straight away by the boundary and the
 * headers of the next part, which makes the browser show it at once. The parts carry no Content-Length (the size of
 * the next frame is not known yet); multipart parsers find the parts by their boundary.
 */
export function startMjpeg(res: ServerResponse): (jpeg: Buffer) => void {
  res.writeHead(200, { 'content-type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`, 'cache-control': 'no-store', connection: 'close', 'x-accel-buffering': 'no' });
  res.write(NEXT_PART.slice(2));
  return (buf: Buffer) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(buf);
    res.write(NEXT_PART);
  };
}
