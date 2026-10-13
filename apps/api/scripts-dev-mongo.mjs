// Local development MongoDB (real mongod binary via mongodb-memory-server) with data kept in ./data/mongo.
// For production use a managed MongoDB or the official image; this is only a convenience.
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mkdirSync } from 'node:fs';

const dbPath = new URL('../../data/mongo/', import.meta.url).pathname;
mkdirSync(dbPath, { recursive: true });
const m = await MongoMemoryServer.create({ instance: { port: 27018, dbPath, storageEngine: 'wiredTiger' } });
console.log(`MongoDB ready: ${m.getUri('pdftools')}`);
process.on('SIGINT', async () => { await m.stop(); process.exit(0); });
process.on('SIGTERM', async () => { await m.stop(); process.exit(0); });
setInterval(() => undefined, 1 << 30);
