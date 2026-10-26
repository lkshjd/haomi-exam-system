import { startWorkerLoop } from '../lib/worker';

startWorkerLoop().catch((err) => {
  console.error(err);
  process.exit(1);
});
