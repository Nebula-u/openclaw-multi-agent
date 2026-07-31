import { spawn } from 'node:child_process';

spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
setInterval(() => {}, 1000);
