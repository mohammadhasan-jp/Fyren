/**
 * Cross-platform "open this URL in the default browser," without the `open`
 * npm package. That package is itself a thin wrapper around exactly this:
 * `execFile` with a platform-specific command. `execFile` (not `exec`) so the
 * URL is passed as an argv entry, never interpolated into a shell string.
 *
 * Best-effort only: a failed auto-open must never crash the server — the
 * caller already has the URL to hand the user manually.
 */

import { execFile } from 'node:child_process';

export function openBrowser(url: string): void {
  const platform = process.platform;

  let cmd: string;
  let args: string[];
  if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (platform === 'win32') {
    // The empty string is a required placeholder — `start`'s first quoted
    // argument is taken as the window title, not the URL.
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }

  execFile(cmd, args, () => {
    // Ignored on purpose — see file header.
  });
}
