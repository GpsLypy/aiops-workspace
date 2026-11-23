import { createApplication } from './app.mjs';

const application = createApplication({ scheduler: false });
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3001);
let server, closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  application.engine.stop();
  application.execution.stop();
  setTimeout(() => process.exit(1), 10000).unref();
  await new Promise(resolveClose => server ? server.close(resolveClose) : resolveClose());
  await application.close(); process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
try {
  await application.engine.warmup();
  if (!closing) {
    server = application.app.listen(port, host, () => {
      application.scheduler.start(); application.operations.start();
      console.log(`AIOps API: http://${host}:${port}`);
    });
    server.on('error', async () => { console.error('API listener failed'); await application.close(); process.exitCode = 1; });
  }
} catch (error) {
  if (!closing) { console.error(error.status ? error.message : 'Agent runtime startup failed'); await application.close(); process.exitCode = 1; }
}
