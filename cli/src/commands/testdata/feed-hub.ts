import { FeedHub } from '../../lib/feed/hub.js';
import { FeedHubServer } from '../../lib/feed/hub-server.js';
import { watchFleetFeed, watchLocalFeed } from '../../lib/feed/watch.js';
import { machineId } from '../../lib/machine-id.js';

const local = new FeedHub({
  watch: ({ signal, emit }) => watchLocalFeed({ scope: machineId(), signal, emit, sessions: { heartbeatMs: 200 } }),
});
const server = new FeedHubServer(new FeedHub({ watch: watchFleetFeed }), undefined, local);
await server.start();
process.stdout.write('ready\n');
process.once('SIGTERM', () => { void server.stop().then(() => process.exit(0)); });
