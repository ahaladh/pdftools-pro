import { startStack, stopStack } from './stack';

export default async function globalSetup() {
  await startStack();
  return async () => { await stopStack(); };
}
