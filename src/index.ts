import { loadConfig } from './config.ts';
import { createServer } from './server.ts';

const config = loadConfig();
const app = createServer(config);

app.listen(config.port, () => {
  console.log(`tengen registry proxy started`);
  console.log(`  upstream:   ${config.upstream}`);
  console.log(`  delay:      ${config.delayDays} day(s)`);
  console.log(`  listening:  http://localhost:${config.port}`);
});
