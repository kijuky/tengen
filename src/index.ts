import { loadConfig } from './config.ts';
import { createServer } from './server.ts';

const config = loadConfig();
const app = createServer(config);

app.listen(config.port, config.host, () => {
  console.log(`tengen registry proxy started`);
  for (const [name, url] of Object.entries(config.upstreams)) {
    console.log(`  ${name.padEnd(10)}  ${url}`);
  }
  console.log(`  delay:      ${config.delayDays} day(s)`);
  console.log(`  listening:  http://${config.host}:${config.port}`);
});
